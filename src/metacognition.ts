/**
 * Metacognition module for Vokari.
 *
 * Cycling detection and attention budget analysis.
 * Generalized from Brain's metacognition.mjs.
 *
 * Instead of reading from a journal directory, this operates on arrays of
 * text entries passed in as parameters, making it portable across different
 * storage backends and use cases.
 *
 * Two subsystems:
 * 1. Cycling Detection -- identifies when thinking is repetitive vs. progressing
 * 2. Attention Budget -- tracks where thinking time goes vs. stated priorities
 */

// ── Types ──

export interface TextEntry {
  id: string;
  title: string;
  content: string;
  timestamp: string;
}

export interface CyclingSignal {
  type: 'no_external_data' | 'topic_stagnation' | 'title_repetition';
  severity: 'high' | 'medium' | 'low';
  description: string;
}

export interface CyclingAnalysis {
  score: number;
  signals: CyclingSignal[];
  recommendation: string | null;
  entriesAnalyzed: number;
}

export interface CyclingOpts {
  /** Regex patterns that indicate external data fetching. */
  externalDataPatterns?: RegExp[];
  /** Keywords to track for topic stagnation. If empty, uses word frequency instead. */
  topicKeywords?: string[];
  /** Number of entries to analyze (default: 5). */
  sessionsBack?: number;
}

export interface AttentionCategory {
  weight: number;
  keywords: string[];
  label: string;
}

export interface AttentionAlert {
  type: string;
  severity: string;
  message: string;
}

export interface AttentionAnalysis {
  breakdown: Record<string, number>;
  alignmentScore: number;
  alerts: AttentionAlert[];
  entriesAnalyzed: number;
}

export interface AttentionOpts {
  /** Number of entries to analyze (default: 10). */
  sessionsBack?: number;
  /**
   * Threshold above which a category triggers an "over" alert.
   * Default: 0.5 for each category.
   */
  overThreshold?: number;
  /**
   * Threshold below which the highest-weight category triggers an "under" alert.
   * Default: 0.1.
   */
  underThreshold?: number;
}

// ── Default patterns ──

const DEFAULT_EXTERNAL_DATA_PATTERNS: RegExp[] = [
  /WebSearch|WebFetch/i,
  /searched for|fetched from|according to recent/i,
  /\[Source:|Sources:/i,
  /API (?:call|response|result)/i,
  /retrieved from|queried|looked up/i,
];

// ── Cycling Detection ──

/**
 * Check if a text entry contains evidence of external data fetching.
 */
function hasExternalData(content: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(content));
}

/**
 * Extract topic keywords from content.
 * If a keyword list is provided, matches against it.
 * Otherwise, uses word frequency analysis.
 */
function extractEntryTopics(content: string, topicKeywords?: string[]): string[] {
  const lower = content.toLowerCase();

  if (topicKeywords && topicKeywords.length > 0) {
    return topicKeywords.filter(kw => lower.includes(kw.toLowerCase()));
  }

  // Fallback: word frequency (words > 5 chars, appearing 2+ times)
  const words = new Map<string, number>();
  const tokens = lower.match(/\b[a-z]{5,}\b/g) || [];
  for (const w of tokens) {
    words.set(w, (words.get(w) || 0) + 1);
  }

  return [...words.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);
}

/**
 * Analyze entries for cycling patterns.
 *
 * Three signals:
 * 1. No external data: entries without evidence of external data fetching
 * 2. Topic stagnation: same topics appearing across nearly all entries
 * 3. Title repetition: repeated significant words in entry titles
 *
 * @param entries - Array of text entries to analyze (most recent first)
 * @param opts - Configuration options
 */
export function analyzeCycling(entries: TextEntry[], opts?: CyclingOpts): CyclingAnalysis {
  const sessionsBack = opts?.sessionsBack ?? 5;
  const externalPatterns = opts?.externalDataPatterns ?? DEFAULT_EXTERNAL_DATA_PATTERNS;
  const topicKeywords = opts?.topicKeywords;

  const recentEntries = entries.slice(0, sessionsBack);

  if (recentEntries.length < 2) {
    return {
      score: 0,
      signals: [],
      recommendation: null,
      entriesAnalyzed: recentEntries.length,
    };
  }

  const signals: CyclingSignal[] = [];
  let cyclingScore = 0;

  // Signal 1: No external data for N consecutive entries
  const entriesWithoutExternal: string[] = [];
  for (const entry of recentEntries) {
    if (!hasExternalData(entry.content, externalPatterns)) {
      entriesWithoutExternal.push(entry.id);
    }
  }
  if (entriesWithoutExternal.length >= 3) {
    signals.push({
      type: 'no_external_data',
      severity: 'high',
      description: `${entriesWithoutExternal.length} entries without external data fetching`,
    });
    cyclingScore += 0.3;
  }

  // Signal 2: Topic stagnation (same topics across most entries)
  const topicCounts = new Map<string, number>();
  for (const entry of recentEntries) {
    const topics = extractEntryTopics(entry.content, topicKeywords);
    for (const topic of topics) {
      topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1);
    }
  }
  const topTopics = [...topicCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const stagnantTopics = topTopics.filter(([, count]) => count >= sessionsBack - 1);
  if (stagnantTopics.length >= 2) {
    signals.push({
      type: 'topic_stagnation',
      severity: 'medium',
      description: `Topics appearing in ${sessionsBack - 1}+ entries: ${stagnantTopics.map(([t]) => t).join(', ')}`,
    });
    cyclingScore += 0.2;
  }

  // Signal 3: Title repetition (similar focus across entries)
  const titleWords = new Map<string, number>();
  for (const entry of recentEntries) {
    const words = entry.title.toLowerCase().split(/\s+/);
    for (const word of words) {
      if (word.length > 4) {
        titleWords.set(word, (titleWords.get(word) || 0) + 1);
      }
    }
  }
  const repeatedTitleWords = [...titleWords.entries()]
    .filter(([, count]) => count >= 3)
    .map(([word]) => word);
  if (repeatedTitleWords.length >= 2) {
    signals.push({
      type: 'title_repetition',
      severity: 'low',
      description: `Repeated title words: ${repeatedTitleWords.join(', ')}`,
    });
    cyclingScore += 0.1;
  }

  // Generate recommendation based on signals
  let recommendation: string | null = null;
  if (cyclingScore >= 0.4) {
    const actions: string[] = [];
    if (entriesWithoutExternal.length >= 3) {
      actions.push('REQUIRED: Incorporate external data before drawing conclusions');
    }
    if (stagnantTopics.length >= 2) {
      const avoidTopics = stagnantTopics.slice(0, 2).map(([t]) => t);
      actions.push(`AVOID: Topics "${avoidTopics.join('", "')}" -- explore something different`);
    }
    recommendation = actions.join('\n');
  }

  return {
    score: Math.min(cyclingScore, 1),
    signals,
    recommendation,
    entriesAnalyzed: recentEntries.length,
  };
}

/**
 * Generate an intervention block for injection into a prompt.
 * Returns intervention text if cycling is detected above threshold,
 * or an empty string if things look healthy.
 *
 * @param entries - Array of text entries to analyze
 * @param threshold - Score threshold for triggering intervention (default: 0.4)
 * @param opts - Cycling analysis options
 */
export function getCyclingIntervention(
  entries: TextEntry[],
  threshold: number = 0.4,
  opts?: CyclingOpts,
): string {
  const analysis = analyzeCycling(entries, opts);

  if (analysis.score < threshold) {
    return '';
  }

  const parts: string[] = [
    '**CYCLING DETECTED**',
    `Analysis of last ${analysis.entriesAnalyzed} entries shows repetitive patterns (score: ${(analysis.score * 100).toFixed(0)}%).`,
  ];

  for (const signal of analysis.signals) {
    if (signal.severity === 'high') {
      parts.push(`- **${signal.type}**: ${signal.description}`);
    } else {
      parts.push(`- ${signal.type}: ${signal.description}`);
    }
  }

  if (analysis.recommendation) {
    parts.push('');
    parts.push('**Required actions:**');
    parts.push(analysis.recommendation);
  }

  return parts.join('\n');
}

// ── Attention Budget ──

/**
 * Categorize text content by keyword frequency against a set of categories.
 * Returns a normalized breakdown where values sum to 1.0.
 *
 * @param content - Text to categorize
 * @param categories - Map of category name to AttentionCategory config
 */
export function categorizeContent(
  content: string,
  categories: Record<string, AttentionCategory>,
): Record<string, number> {
  const scores: Record<string, number> = {};
  let totalMatches = 0;

  for (const [category, config] of Object.entries(categories)) {
    let matches = 0;
    for (const keyword of config.keywords) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const isPhrase = keyword.includes(' ');
      const regex = isPhrase
        ? new RegExp(escaped, 'gi')
        : new RegExp(`\\b${escaped}\\b`, 'gi');
      const found = (content.match(regex) || []).length;
      matches += found;
    }
    scores[category] = matches;
    totalMatches += matches;
  }

  // Normalize to percentages
  const breakdown: Record<string, number> = {};
  for (const category of Object.keys(categories)) {
    breakdown[category] = totalMatches > 0 ? scores[category] / totalMatches : 0;
  }

  return breakdown;
}

/**
 * Calculate a priority alignment score (0-1).
 *
 * Higher scores mean attention is weighted toward higher-priority categories.
 * 1.0 = all attention on the highest-weight category.
 * 0.0 = all attention on a category with weight 0.
 *
 * @param breakdown - Normalized attention breakdown (values sum to ~1.0)
 * @param categories - Category definitions with weights
 */
export function calculateAlignmentScore(
  breakdown: Record<string, number>,
  categories: Record<string, AttentionCategory>,
): number {
  let weightedActual = 0;
  let maxWeight = 0;

  for (const [category, config] of Object.entries(categories)) {
    const actual = breakdown[category] || 0;
    weightedActual += actual * config.weight;
    if (config.weight > maxWeight) maxWeight = config.weight;
  }

  // Normalize by max possible weight so score is 0-1
  return maxWeight > 0 ? weightedActual / maxWeight : 0;
}

/**
 * Analyze attention budget across a set of entries.
 *
 * Aggregates content categorization, calculates alignment with priorities,
 * and generates alerts for misalignments.
 *
 * @param entries - Text entries to analyze
 * @param categories - Category definitions with weights and keywords
 * @param opts - Analysis options
 */
export function analyzeAttentionBudget(
  entries: TextEntry[],
  categories: Record<string, AttentionCategory>,
  opts?: AttentionOpts,
): AttentionAnalysis {
  const sessionsBack = opts?.sessionsBack ?? 10;
  const overThreshold = opts?.overThreshold ?? 0.5;
  const underThreshold = opts?.underThreshold ?? 0.1;

  const recentEntries = entries.slice(0, sessionsBack);

  if (recentEntries.length < 2) {
    return {
      breakdown: {},
      alignmentScore: 0,
      alerts: [],
      entriesAnalyzed: recentEntries.length,
    };
  }

  // Aggregate breakdown across all entries
  const aggregateBreakdown: Record<string, number> = {};
  for (const category of Object.keys(categories)) {
    aggregateBreakdown[category] = 0;
  }

  for (const entry of recentEntries) {
    const entryBreakdown = categorizeContent(entry.content, categories);
    for (const category of Object.keys(categories)) {
      aggregateBreakdown[category] += entryBreakdown[category] ?? 0;
    }
  }

  // Normalize aggregate
  const total = Object.values(aggregateBreakdown).reduce((a, b) => a + b, 0);
  for (const category of Object.keys(aggregateBreakdown)) {
    aggregateBreakdown[category] = total > 0 ? aggregateBreakdown[category] / total : 0;
  }

  const alignmentScore = calculateAlignmentScore(aggregateBreakdown, categories);

  // Generate alerts for misalignments
  const alerts: AttentionAlert[] = [];

  // Find the highest-weight category
  let highestWeightCat = '';
  let highestWeight = -1;
  // Find the lowest-weight category
  let lowestWeightCat = '';
  let lowestWeight = Infinity;

  for (const [cat, config] of Object.entries(categories)) {
    if (config.weight > highestWeight) {
      highestWeight = config.weight;
      highestWeightCat = cat;
    }
    if (config.weight < lowestWeight) {
      lowestWeight = config.weight;
      lowestWeightCat = cat;
    }
  }

  // Alert: any category exceeding overThreshold
  for (const [cat, config] of Object.entries(categories)) {
    const value = aggregateBreakdown[cat] ?? 0;
    if (value > overThreshold) {
      alerts.push({
        type: `over_${cat}`,
        severity: 'warning',
        message: `${config.label} at ${(value * 100).toFixed(0)}% -- exceeds ${(overThreshold * 100).toFixed(0)}% threshold`,
      });
    }
  }

  // Alert: highest-priority category below underThreshold
  if (highestWeightCat && (aggregateBreakdown[highestWeightCat] ?? 0) < underThreshold) {
    const config = categories[highestWeightCat];
    alerts.push({
      type: `under_${highestWeightCat}`,
      severity: 'info',
      message: `${config.label} at ${((aggregateBreakdown[highestWeightCat] ?? 0) * 100).toFixed(0)}% -- highest priority category is underrepresented`,
    });
  }

  // Alert: lowest-priority category dominating (>30%)
  if (lowestWeightCat && (aggregateBreakdown[lowestWeightCat] ?? 0) > 0.3) {
    const config = categories[lowestWeightCat];
    alerts.push({
      type: `over_low_priority_${lowestWeightCat}`,
      severity: 'warning',
      message: `${config.label} at ${((aggregateBreakdown[lowestWeightCat] ?? 0) * 100).toFixed(0)}% -- consider more practical topics`,
    });
  }

  return {
    breakdown: aggregateBreakdown,
    alignmentScore,
    alerts,
    entriesAnalyzed: recentEntries.length,
  };
}
