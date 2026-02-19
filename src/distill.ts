/**
 * Signal/noise classification and log compaction module for Vokari.
 *
 * Generalized from Brain's distill.mjs. Extracts durable insights from
 * raw log content, separating signal from noise.
 *
 * Designed to work with any text-based logging system:
 * - Classification: identify which lines are signal vs. noise
 * - Digest building: group signals by category into structured output
 * - Compaction: collapse repetitive entries while preserving important ones
 * - Theme analysis: find recurring topics across multiple text bodies
 */

// ── Types ──

export interface ClassificationRule {
  pattern: RegExp;
  category: string;
}

export interface ClassificationResult {
  isSignal: boolean;
  category: string;
}

export interface SignalExtractionResult {
  signal: string[];
  noise: number;
  total: number;
  categories: Record<string, number>;
}

export interface CompactionRules {
  /** Lines matching these patterns are preserved verbatim. */
  preserve: RegExp[];
  /** Lines matching these patterns are collapsed into counts. */
  collapse: CollapseRule[];
  /** Lines matching these patterns are removed entirely. */
  remove: RegExp[];
}

export interface CollapseRule {
  pattern: RegExp;
  group: string;
  /** Capture group index for the sub-key (null for no sub-key). */
  key: number | null;
}

export interface CompactionStats {
  originalLines: number;
  preservedLines: number;
  collapsedGroups: number;
  compressionRatio: string;
}

export interface CompactionResult {
  compacted: string;
  stats: CompactionStats;
}

export interface RecurringTheme {
  word: string;
  documentCount: number;
  totalDocuments: number;
}

export interface RecurringThemeOpts {
  /** Minimum number of documents a word must appear in (default: 2). */
  minDocuments?: number;
  /** Maximum number of themes to return (default: 20). */
  maxThemes?: number;
  /** Additional stop words to filter out. */
  extraStopWords?: string[];
}

// ── Default Patterns ──

/**
 * Default noise patterns for log classification.
 * These represent common operational log entries that rarely contain insights.
 */
export const DEFAULT_NOISE_PATTERNS: ClassificationRule[] = [
  { pattern: /(?:cron|job|task) (?:started|completed|finished)/i, category: 'operational' },
  { pattern: /(?:cron|job|task) .+ skipped/i, category: 'operational' },
  { pattern: /(?:transcript|log) saved/i, category: 'operational' },
  { pattern: /session (?:archived|restored|expired)/i, category: 'operational' },
  { pattern: /subprocess (?:spawned|closed|exited)/i, category: 'operational' },
  { pattern: /daemon (?:started|stopped|restarted)/i, category: 'operational' },
  { pattern: /memory cleanup/i, category: 'operational' },
  { pattern: /notification sent/i, category: 'operational' },
  { pattern: /health ?check (?:passed|ok|200)/i, category: 'operational' },
  { pattern: /heartbeat/i, category: 'operational' },
  { pattern: /saved \d+ (?:active )?session/i, category: 'operational' },
  { pattern: /restored \d+ session/i, category: 'operational' },
  { pattern: /cache (?:hit|miss|cleared|warmed)/i, category: 'operational' },
  { pattern: /retry(?:ing)? (?:in|after) \d+/i, category: 'operational' },
];

/**
 * Default signal patterns for log classification.
 * These represent entries that typically contain valuable information.
 */
export const DEFAULT_SIGNAL_PATTERNS: ClassificationRule[] = [
  { pattern: /(?:chat|message|conversation) (?:from|with)/i, category: 'conversation' },
  { pattern: /ticket (?:created|approved|dismissed|closed)/i, category: 'ticket' },
  { pattern: /(?:decided|decision|chose|approved|rejected)/i, category: 'decision' },
  { pattern: /(?:config|setting|job) (?:created|updated|deleted|changed)/i, category: 'config-change' },
  { pattern: /\[ALERT\]/i, category: 'error' },
  { pattern: /\[CRITICAL\]/i, category: 'error' },
  { pattern: /\[ERROR\]/i, category: 'error' },
  { pattern: /unhandled (?:rejection|exception)/i, category: 'error' },
  { pattern: /(?:uncaught|unexpected) (?:error|exception)/i, category: 'error' },
  { pattern: /(?:cron|job|task) .+ failed/i, category: 'error' },
  { pattern: /(?:context|session) (?:overflow|compaction)/i, category: 'session' },
  { pattern: /deployment (?:started|completed|failed)/i, category: 'deployment' },
  { pattern: /migration (?:started|completed|failed)/i, category: 'deployment' },
];

// ── Classification ──

/**
 * Classify a single line as signal or noise.
 *
 * Checks noise patterns first, then signal patterns.
 * Lines that match neither are treated as signal (err on the side of keeping).
 *
 * @param line - The line of text to classify
 * @param noisePatterns - Patterns indicating noise
 * @param signalPatterns - Patterns indicating signal
 */
export function classifyLine(
  line: string,
  noisePatterns: ClassificationRule[],
  signalPatterns: ClassificationRule[],
): ClassificationResult {
  const text = line.trim();
  if (!text) return { isSignal: false, category: 'empty' };

  // Check noise patterns first
  for (const { pattern, category } of noisePatterns) {
    if (pattern.test(text)) return { isSignal: false, category };
  }

  // Check signal patterns
  for (const { pattern, category } of signalPatterns) {
    if (pattern.test(text)) return { isSignal: true, category };
  }

  // Default: treat as signal (err on side of keeping)
  return { isSignal: true, category: 'other' };
}

/**
 * Extract signal lines from raw content.
 * Returns the signal lines, noise count, total count, and category breakdown.
 *
 * @param content - Raw text content (newline-separated)
 * @param noisePatterns - Patterns indicating noise
 * @param signalPatterns - Patterns indicating signal
 */
export function extractSignal(
  content: string,
  noisePatterns: ClassificationRule[],
  signalPatterns: ClassificationRule[],
): SignalExtractionResult {
  const lines = content.split('\n').filter(l => l.trim());
  const signal: string[] = [];
  let noise = 0;
  const categories: Record<string, number> = {};

  for (const line of lines) {
    const { isSignal, category } = classifyLine(line, noisePatterns, signalPatterns);
    categories[category] = (categories[category] || 0) + 1;
    if (isSignal) {
      signal.push(line);
    } else {
      noise++;
    }
  }

  return { signal, noise, total: lines.length, categories };
}

// ── Digest Building ──

/**
 * Build a categorized digest from raw log content.
 *
 * Extracts signal lines, groups them by category, and formats
 * into a structured markdown document.
 *
 * @param title - Title for the digest (e.g., a date or identifier)
 * @param content - Raw log content
 * @param noisePatterns - Patterns indicating noise
 * @param signalPatterns - Patterns indicating signal
 */
export function buildDigest(
  title: string,
  content: string,
  noisePatterns: ClassificationRule[],
  signalPatterns: ClassificationRule[],
): string {
  const { signal, noise, total } = extractSignal(content, noisePatterns, signalPatterns);

  const parts: string[] = [`# Digest -- ${title}`, ''];
  parts.push(`_${signal.length} signal lines extracted from ${total} total (${noise} noise filtered)_`);
  parts.push('');

  if (signal.length === 0) {
    parts.push('No signal lines found.');
    return parts.join('\n');
  }

  // Group signal by category
  const grouped: Record<string, string[]> = {};
  for (const line of signal) {
    const { category } = classifyLine(line, noisePatterns, signalPatterns);
    if (!grouped[category]) grouped[category] = [];
    grouped[category].push(line);
  }

  // Category display order: errors first, then conversations, then rest
  const priorityOrder = ['error', 'conversation', 'decision', 'ticket', 'config-change', 'session', 'deployment'];
  const sortedCategories = Object.keys(grouped).sort((a, b) => {
    const ai = priorityOrder.indexOf(a);
    const bi = priorityOrder.indexOf(b);
    const aIdx = ai >= 0 ? ai : priorityOrder.length;
    const bIdx = bi >= 0 ? bi : priorityOrder.length;
    return aIdx - bIdx;
  });

  for (const cat of sortedCategories) {
    const lines = grouped[cat];
    if (!lines || lines.length === 0) continue;

    // Capitalize category for display
    const label = cat.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    parts.push(`## ${label}`);
    for (const line of lines) {
      parts.push(line);
    }
    parts.push('');
  }

  return parts.join('\n');
}

// ── Log Compaction ──

/** Internal tracking for collapsed entries. */
interface CollapseEntry {
  count: number;
  group: string;
  subkey: string | null;
}

/**
 * Compact log content by collapsing repetitive entries.
 *
 * Three-tier approach:
 * 1. Preserve: important lines kept verbatim
 * 2. Collapse: repetitive lines grouped into counts
 * 3. Remove: pure noise removed entirely
 *
 * Lines that match no rules are preserved.
 *
 * @param content - Raw log content
 * @param rules - Compaction rules (preserve, collapse, remove patterns)
 */
export function compactLog(content: string, rules: CompactionRules): CompactionResult {
  const lines = content.split('\n');
  const preserved: string[] = [];
  const collapsed = new Map<string, CollapseEntry>();
  let removedCount = 0;

  for (const line of lines) {
    const text = line.trim();

    // Keep empty lines / non-list lines as structural elements
    if (!text) {
      preserved.push(line);
      continue;
    }

    // Check if line should be preserved
    let shouldPreserve = false;
    for (const pattern of rules.preserve) {
      if (pattern.test(text)) {
        shouldPreserve = true;
        break;
      }
    }
    if (shouldPreserve) {
      preserved.push(line);
      continue;
    }

    // Check if line should be removed
    let shouldRemove = false;
    for (const pattern of rules.remove) {
      if (pattern.test(text)) {
        shouldRemove = true;
        break;
      }
    }
    if (shouldRemove) {
      removedCount++;
      continue;
    }

    // Check if line can be collapsed
    let wasCollapsed = false;
    for (const rule of rules.collapse) {
      const match = text.match(rule.pattern);
      if (match) {
        const groupKey = rule.key !== null && match[rule.key]
          ? `${rule.group}:${match[rule.key]}`
          : rule.group;

        if (!collapsed.has(groupKey)) {
          collapsed.set(groupKey, {
            count: 0,
            group: rule.group,
            subkey: rule.key !== null && match[rule.key] ? match[rule.key] : null,
          });
        }
        const entry = collapsed.get(groupKey)!;
        entry.count++;
        wasCollapsed = true;
        break;
      }
    }

    // If not collapsed, preserve
    if (!wasCollapsed) {
      preserved.push(line);
    }
  }

  // Build collapsed summary lines
  const groupSummaries = new Map<string, { subkey: string | null; count: number }[]>();
  for (const [, entry] of collapsed) {
    if (!groupSummaries.has(entry.group)) {
      groupSummaries.set(entry.group, []);
    }
    groupSummaries.get(entry.group)!.push({
      subkey: entry.subkey,
      count: entry.count,
    });
  }

  const summaryLines: string[] = [];
  for (const [group, entries] of groupSummaries) {
    const totalCount = entries.reduce((sum, e) => sum + e.count, 0);
    const hasSubkeys = entries.some(e => e.subkey !== null);

    if (hasSubkeys) {
      const detail = entries.map(e => `${e.subkey} (${e.count}x)`).join(', ');
      summaryLines.push(`[Compacted] ${totalCount} ${group} events: ${detail}`);
    } else {
      summaryLines.push(`[Compacted] ${totalCount} ${group} events`);
    }
  }

  // Append summary at the end
  const compactedLines = [...preserved];
  if (summaryLines.length > 0) {
    compactedLines.push('');
    compactedLines.push('### Compacted Summary');
    for (const line of summaryLines) {
      compactedLines.push(`- _${line}_`);
    }
  }

  const collapsedEntries = [...collapsed.values()].reduce((sum, e) => sum + e.count, 0);
  const finalLineCount = compactedLines.filter(l => l.trim()).length;

  const stats: CompactionStats = {
    originalLines: lines.filter(l => l.trim()).length,
    preservedLines: preserved.filter(l => l.trim()).length,
    collapsedGroups: collapsed.size,
    compressionRatio: lines.length > 0
      ? ((1 - finalLineCount / lines.filter(l => l.trim()).length) * 100).toFixed(1)
      : '0.0',
  };

  return { compacted: compactedLines.join('\n'), stats };
}

// ── Recurring Themes ──

const THEME_STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'was', 'are', 'were', 'be', 'been',
  'has', 'had', 'have', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'this', 'that', 'these', 'those', 'it', 'its',
  'not', 'no', 'yes', 'all', 'each', 'every', 'any', 'some', 'more',
  'about', 'than', 'then', 'just', 'also', 'very', 'too', 'only',
  'other', 'such', 'into', 'over', 'after', 'before', 'between',
  'through', 'during', 'without', 'within', 'along', 'following',
  'across', 'behind', 'beyond', 'plus', 'except', 'since', 'until',
  'what', 'which', 'who', 'whom', 'how', 'when', 'where', 'why',
  'there', 'here', 'they', 'them', 'their', 'our', 'your', 'his', 'her',
  'signal', 'lines', 'total', 'noise', 'filtered', 'daily', 'digest',
]);

/**
 * Find recurring themes across multiple text bodies.
 *
 * Uses word frequency analysis, counting how many documents each word
 * appears in (not total occurrences) to find cross-cutting themes.
 *
 * @param contents - Array of text bodies to analyze
 * @param opts - Configuration options
 */
export function getRecurringThemes(contents: string[], opts?: RecurringThemeOpts): RecurringTheme[] {
  const minDocuments = opts?.minDocuments ?? 2;
  const maxThemes = opts?.maxThemes ?? 20;
  const extraStopWords = opts?.extraStopWords ?? [];

  const allStopWords = new Set([...THEME_STOP_WORDS, ...extraStopWords.map(w => w.toLowerCase())]);

  const wordDocFreq = new Map<string, number>();

  for (const content of contents) {
    // Extract meaningful words (3+ chars, not stop words)
    const words = content.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3 && !allStopWords.has(w));

    // Count each word only once per document
    const seen = new Set<string>();
    for (const word of words) {
      if (!seen.has(word)) {
        seen.add(word);
        wordDocFreq.set(word, (wordDocFreq.get(word) || 0) + 1);
      }
    }
  }

  return [...wordDocFreq.entries()]
    .filter(([, count]) => count >= minDocuments)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxThemes)
    .map(([word, count]) => ({
      word,
      documentCount: count,
      totalDocuments: contents.length,
    }));
}
