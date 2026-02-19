/**
 * Post-conversation learning module for Vokari.
 *
 * Extracts structured signals from conversation transcripts using
 * lightweight heuristics (no LLM calls). Adapted from Brain's learning.mjs.
 *
 * This is the CAPTURE layer, not the UNDERSTANDING layer.
 * Complex synthesis belongs elsewhere (e.g., scheduled analysis sessions).
 *
 * Capabilities:
 * 1. URL extraction from message text
 * 2. Belief/preference signal extraction via regex heuristics
 * 3. Topic frequency extraction from user messages
 * 4. Correction detection (user correcting the assistant)
 */

// ── Types ──

export interface Message {
  role: string;
  content: string;
}

export interface ExtractedBelief {
  statement: string;
  category: string;
  confidence: number;
  tags: string[];
  source: string;
  evidence: string[];
}

export interface ExtractedTopic {
  word: string;
  count: number;
}

export interface ExtractedCorrection {
  type: 'factual_correction' | 'preference_correction' | 'repeated_correction';
  content: string;
  example_bad?: string;
  example_good?: string;
}

// ── Internal pattern types ──

interface BeliefPattern {
  pattern: RegExp;
  category: string;
  confidence: number;
  extract: (match: RegExpMatchArray) => { statement: string; tags: string[] };
}

// ── URL Extraction ──

/** Match HTTP/HTTPS URLs in text. */
const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/gi;

/** URLs to skip (common noise sources). */
const URL_SKIP_PATTERNS: RegExp[] = [
  /localhost/i,
  /127\.0\.0\.1/,
  /0\.0\.0\.0/,
  /\[::1\]/,
  /example\.com/i,
  /placeholder\./i,
  /claude\.com\/claude-code/i,
];

/**
 * Extract unique, meaningful URLs from text.
 * Filters out localhost, example domains, and common false positives.
 * Cleans trailing punctuation and markdown artifacts.
 */
export function extractUrls(text: string): string[] {
  const matches = text.match(URL_PATTERN) || [];
  const seen = new Set<string>();
  const urls: string[] = [];

  for (let url of matches) {
    // Clean trailing punctuation
    url = url.replace(/[.,;:!?)]+$/, '');
    // Remove trailing markdown parens
    url = url.replace(/\)+$/, '');

    if (seen.has(url)) continue;
    seen.add(url);

    // Skip noise URLs
    if (URL_SKIP_PATTERNS.some(p => p.test(url))) continue;

    urls.push(url);
  }

  return urls;
}

// ── Belief Extraction ──

/**
 * Heuristic patterns for extracting preference/belief signals.
 * Intentionally conservative to minimize false positives.
 */
const BELIEF_PATTERNS: BeliefPattern[] = [
  // 1. "I prefer/like/want X [over Y]" -> user preference
  {
    pattern: /I (?:prefer|like|want|love|enjoy|always use|stick with)\s+(.{3,60}?)(?:\s+(?:over|instead of|rather than|more than)\s+(.{3,60}))?[.!?\s]*$/im,
    category: 'user',
    confidence: 0.75,
    extract: (m: RegExpMatchArray) => ({
      statement: m[2]
        ? `User prefers ${m[1].trim()} over ${m[2].trim()}`
        : `User prefers ${m[1].trim()}`,
      tags: ['preference'],
    }),
  },
  // 2. "I don't like/hate/avoid X" -> user dislike
  {
    pattern: /I (?:don'?t like|hate|dislike|avoid|never use)\s+(.{3,60})[.!?\s]*$/im,
    category: 'user',
    confidence: 0.7,
    extract: (m: RegExpMatchArray) => ({
      statement: `User dislikes ${m[1].trim()}`,
      tags: ['preference'],
    }),
  },
  // 3. "at work/we're using X" -> work context
  {
    pattern: /(?:at work|my team|we(?:'re| are) (?:using|migrating|building|deploying))\s+(.{5,80})[.!?\s]*$/im,
    category: 'user',
    confidence: 0.65,
    extract: (m: RegExpMatchArray) => ({
      statement: `Work context: ${m[1].trim()}`,
      tags: ['work'],
    }),
  },
  // 4. "my wife/kids/family X" -> family context
  {
    pattern: /(?:my (?:wife|husband|partner|kids?|daughter|son|family))\s+(?:is|are|has|have|needs?|wants?|started?|going)\s+(.{5,80})[.!?\s]*$/im,
    category: 'user',
    confidence: 0.6,
    extract: (m: RegExpMatchArray) => ({
      statement: `Family: ${m[0].trim()}`,
      tags: ['family'],
    }),
  },
  // 5. "I decided/chose X" -> decision
  {
    pattern: /(?:I (?:decided|chose|went with|picked|settled on)|let'?s (?:go with|use|do))\s+(.{3,60})[.!?\s]*$/im,
    category: 'user',
    confidence: 0.7,
    extract: (m: RegExpMatchArray) => ({
      statement: `Decision: ${m[1].trim()}`,
      tags: ['decision'],
    }),
  },
];

/**
 * Extract the text content from a message.
 * Handles both plain string content and structured content arrays.
 */
function getMessageText(content: string | unknown): string {
  if (typeof content === 'string') return content;

  // Handle array-style content (e.g., [{type: 'text', text: '...'}])
  if (Array.isArray(content)) {
    return content
      .filter((part: unknown) => {
        const p = part as Record<string, unknown>;
        return p && typeof p === 'object' && p.type === 'text';
      })
      .map((part: unknown) => (part as Record<string, unknown>).text as string)
      .join('\n');
  }

  return '';
}

/**
 * Extract belief signals from conversation messages.
 * Only processes user messages. Returns an array of belief objects
 * ready for addBelief().
 *
 * @param messages - Array of conversation messages
 * @param sessionId - Session identifier for provenance tracking
 */
export function extractBeliefs(messages: Message[], sessionId: string): ExtractedBelief[] {
  const beliefs: ExtractedBelief[] = [];
  const seenStatements = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    const text = getMessageText(msg.content);
    if (!text || text.length < 10) continue;

    for (const { pattern, category, confidence, extract } of BELIEF_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        try {
          const belief = extract(match);

          // Deduplicate within session
          if (seenStatements.has(belief.statement)) continue;
          seenStatements.add(belief.statement);

          beliefs.push({
            ...belief,
            category,
            confidence,
            source: `conversation:${sessionId}`,
            evidence: [text.substring(0, 200)],
          });
        } catch {
          // Pattern matched but extraction failed -- skip
        }
      }
    }
  }

  return beliefs;
}

// ── Topic Extraction ──

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'must', 'need', 'to', 'of',
  'in', 'for', 'on', 'with', 'at', 'by', 'from', 'up', 'about', 'into',
  'through', 'during', 'before', 'after', 'above', 'below', 'between',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
  'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'than', 'too', 'very', 'just',
  'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
  'it', 'its', 'he', 'she', 'they', 'them', 'we', 'you', 'me', 'my',
  'your', 'his', 'her', 'our', 'their', 'how', 'when', 'where', 'why',
  'i', 'im', 'ive', 'dont', 'didnt', 'wont', 'cant', 'isnt', 'wasnt',
  'okay', 'yeah', 'yes', 'no', 'sure', 'like', 'know', 'think', 'want',
  'get', 'got', 'make', 'made', 'let', 'go', 'going', 'see', 'look',
  'one', 'two', 'also', 'well', 'now', 'right', 'still', 'even',
]);

/**
 * Extract key topics from user messages by word frequency.
 * Returns top 5 words with at least 2 occurrences.
 */
export function extractTopics(messages: Message[]): ExtractedTopic[] {
  const words = new Map<string, number>();

  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    const text = getMessageText(msg.content).toLowerCase();
    const tokens = text.match(/\b[a-z]{3,}\b/g) || [];
    for (const word of tokens) {
      if (STOP_WORDS.has(word)) continue;
      words.set(word, (words.get(word) || 0) + 1);
    }
  }

  return [...words.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word, count]) => ({ word, count }));
}

// ── Correction Extraction ──

/**
 * Detect user corrections in the conversation.
 * Looks for patterns where the user is correcting the assistant:
 * - "no, it's X not Y"
 * - "that's wrong", "that's incorrect"
 * - "I already told you", "as I said before"
 */
export function extractCorrections(messages: Message[]): ExtractedCorrection[] {
  const corrections: ExtractedCorrection[] = [];
  const seenContent = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    const text = getMessageText(msg.content);
    if (!text || text.length < 5) continue;

    // Pattern 1: "no, it's X not Y" / "no, it should be X not Y"
    const correctionMatch = text.match(
      /\bno[,.]?\s+(?:it(?:'s| is| should be)|the (?:answer|correct|right) (?:is|one is))\s+(.{3,80}?)(?:\s+not\s+(.{3,60}))?[.!?\s]*$/im
    );
    if (correctionMatch) {
      const content = correctionMatch[1].trim();
      if (!seenContent.has(content)) {
        seenContent.add(content);
        corrections.push({
          type: 'factual_correction',
          content,
          example_good: correctionMatch[1].trim(),
          example_bad: correctionMatch[2]?.trim(),
        });
      }
    }

    // Pattern 2: "that's wrong" / "that's incorrect" / "that's not right" / "actually, X"
    const wrongMatch = text.match(
      /\b(?:that(?:'s| is) (?:wrong|incorrect|not (?:right|correct|true|accurate))|you(?:'re| are) wrong|actually[,]\s+(.{5,100}))[.!?\s]*$/im
    );
    if (wrongMatch) {
      const content = wrongMatch[1]?.trim() || text.substring(0, 120).trim();
      if (!seenContent.has(content)) {
        seenContent.add(content);
        corrections.push({
          type: 'factual_correction',
          content,
        });
      }
    }

    // Pattern 3: "I already told you" / "as I said before" / "I mentioned earlier"
    const repeatedMatch = text.match(
      /\b(?:I (?:already told you|said (?:before|earlier)|mentioned (?:before|earlier|that))|as I said)\s*[,:]?\s*(.{5,120})?[.!?\s]*$/im
    );
    if (repeatedMatch) {
      const content = repeatedMatch[1]?.trim() || text.substring(0, 120).trim();
      if (!seenContent.has(content)) {
        seenContent.add(content);
        corrections.push({
          type: 'repeated_correction',
          content,
        });
      }
    }

    // Pattern 4: "I don't want/mean X, I want/mean Y"
    const preferenceCorrection = text.match(
      /\bI (?:don'?t (?:want|mean|need))\s+(.{3,60}?)[,;]\s*I (?:want|mean|need)\s+(.{3,60})[.!?\s]*$/im
    );
    if (preferenceCorrection) {
      const content = `Wants ${preferenceCorrection[2].trim()}, not ${preferenceCorrection[1].trim()}`;
      if (!seenContent.has(content)) {
        seenContent.add(content);
        corrections.push({
          type: 'preference_correction',
          content,
          example_bad: preferenceCorrection[1].trim(),
          example_good: preferenceCorrection[2].trim(),
        });
      }
    }
  }

  return corrections;
}
