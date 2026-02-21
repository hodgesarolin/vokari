/**
 * Context Compiler for Vokari.
 *
 * Dynamically assembles a context window from the unified knowledge store.
 * Three layers:
 * 1. MANDATORY — always included (corrections, identity, decisions)
 * 2. SESSION — varies by session type (interactive, cron_thinking, cron_digest)
 * 3. RELEVANCE — fills remaining budget via hybrid search (FTS5 + optional vector)
 *
 * Key properties:
 * - Budget-aware: never exceeds the character limit
 * - Deterministic base: mandatory + session layers are stable (cacheable)
 * - Dynamic tail: relevance layer adapts to the conversation
 * - Source-agnostic: pulls from knowledge table regardless of origin
 */

import type Database from 'better-sqlite3';
import {
  listKnowledge,
  searchKnowledge,
  getKnowledgeByKey,
} from './knowledge.js';
import type { KnowledgeType, Knowledge, EmbedFn } from './knowledge.js';

// ── Types ──

export type SessionType = 'interactive' | 'cron_thinking' | 'cron_digest' | 'cron_health';

export interface AssembleContextOpts {
  /** Max characters for the assembled context. */
  budget: number;
  /** Session type determines which knowledge is included. */
  sessionType: SessionType;
  /** Optional query for relevance-based retrieval in the third layer. */
  query?: string;
  /** Optional embed function for hybrid search in relevance layer. */
  embedFn?: EmbedFn;
  /** Include section headers in output (default: true). */
  headers?: boolean;
}

export interface AssembleContextResult {
  /** The compiled context string, ready for system prompt injection. */
  context: string;
  /** Breakdown of how the budget was used. */
  breakdown: {
    mandatory: number;
    session: number;
    relevance: number;
    total: number;
    budget: number;
    utilizationPct: number;
  };
  /** IDs of knowledge rows included. */
  includedIds: string[];
  /** Number of rows considered but excluded (budget). */
  excluded: number;
}

interface LayerEntry {
  id: string;
  header?: string;
  content: string;
  priority: number; // lower = more important
}

// ── Session Layer Configs ──

/**
 * Defines which knowledge types/keys to include for each session type.
 * Each entry specifies: type filter, optional key, optional metadata filter,
 * and priority (lower = included first).
 */
interface SessionLayerItem {
  type: KnowledgeType;
  key?: string;
  metadataFilter?: string;
  priority: number;
  header?: string;
  limit?: number;
}

const SESSION_LAYERS: Record<SessionType, SessionLayerItem[]> = {
  interactive: [
    { type: 'handoff', key: 'interactive-context', priority: 10, header: '## Interactive Session Context' },
    { type: 'context', key: 'family', priority: 20, header: '## Family' },
    { type: 'context', key: 'personal', priority: 25, header: '## Personal Context' },
    { type: 'handoff', key: 'daily-todos', priority: 30, header: '## Daily Todos' },
    { type: 'prediction', priority: 40, header: '## Active Predictions', metadataFilter: "json_extract(metadata, '$.outcome') IS NULL", limit: 20 },
    { type: 'position', priority: 50, header: '## Active Positions', metadataFilter: "json_extract(metadata, '$.status') IN ('held', 'challenged')", limit: 30 },
  ],
  cron_thinking: [
    { type: 'handoff', key: 'last-session-handoff', priority: 10, header: '## Last Session Handoff' },
    { type: 'handoff', key: 'nightly-state', priority: 15, header: '## Nightly State' },
    { type: 'position', priority: 20, header: '## Active Positions', metadataFilter: "json_extract(metadata, '$.status') IN ('held', 'challenged')", limit: 30 },
    { type: 'prediction', priority: 30, header: '## Active Predictions', metadataFilter: "json_extract(metadata, '$.outcome') IS NULL", limit: 20 },
  ],
  cron_digest: [
    // Minimal: just corrections (mandatory) + identity + recent events
    { type: 'handoff', key: 'daily-todos', priority: 10, header: '## Daily Todos' },
  ],
  cron_health: [
    { type: 'handoff', key: 'nightly-state', priority: 10, header: '## System State' },
  ],
};

// ── Main API ──

/**
 * Assemble a context window from the knowledge store.
 *
 * Three-layer approach:
 * 1. Mandatory: corrections + identity + decisions (always included)
 * 2. Session: type-specific knowledge (varies by session_type)
 * 3. Relevance: fills remaining budget with search results
 */
export function assembleContext(
  db: Database.Database,
  opts: AssembleContextOpts,
): AssembleContextResult {
  const {
    budget,
    sessionType,
    query,
    headers = true,
  } = opts;

  const includedIds: string[] = [];
  const includedIdSet = new Set<string>(); // For fast dedup lookups
  const sections: string[] = [];
  let usedChars = 0;
  let excluded = 0;

  /**
   * Try to add a section. Returns true if added, false if over budget.
   * Accounts for the separator that join('\n') will add.
   */
  function tryAdd(text: string, ids: string[]): boolean {
    const separatorCost = sections.length > 0 ? 1 : 0; // '\n' between sections
    if (usedChars + text.length + separatorCost <= budget) {
      sections.push(text);
      usedChars += text.length + separatorCost;
      for (const id of ids) {
        includedIds.push(id);
        // Track individual IDs even from comma-joined entries
        for (const subId of id.split(',')) {
          includedIdSet.add(subId);
        }
      }
      return true;
    }
    return false;
  }

  // ── Layer 1: MANDATORY ──

  const mandatoryEntries = getMandatoryLayer(db);
  const mandatoryStart = usedChars;

  for (const entry of mandatoryEntries) {
    const text = formatEntry(entry, headers);
    if (!tryAdd(text, [entry.id])) {
      excluded++;
    }
  }

  const mandatorySize = usedChars - mandatoryStart;

  // ── Layer 2: SESSION ──

  const sessionEntries = getSessionLayer(db, sessionType);
  const sessionStart = usedChars;

  for (const entry of sessionEntries) {
    const text = formatEntry(entry, headers);
    if (!tryAdd(text, [entry.id])) {
      excluded++;
    }
  }

  const sessionSize = usedChars - sessionStart;

  // ── Layer 3: RELEVANCE ──

  const relevanceStart = usedChars;
  const remainingBudget = budget - usedChars;

  if (remainingBudget > 200 && query) {
    // Search for relevant content
    const searchResults = searchKnowledge(db, query, {
      limit: 20,
    });

    for (const result of searchResults) {
      if (includedIdSet.has(result.id)) continue;

      const text = headers
        ? `\n### [${result.type}] ${result.key ?? ''}\n${result.content}\n`
        : `\n${result.content}\n`;

      if (!tryAdd(text, [result.id])) {
        excluded++;
      }
    }
  } else if (remainingBudget > 200 && !query) {
    // No query — fill with recent/high-relevance content
    const recentItems = listKnowledge(db, {
      types: ['research', 'context', 'archive', 'daily'],
      limit: 10,
      orderBy: 'updated_at DESC',
    });

    for (const item of recentItems) {
      if (includedIdSet.has(item.id)) continue;

      const text = headers
        ? `\n### [${item.type}] ${item.key ?? ''}\n${item.content}\n`
        : `\n${item.content}\n`;

      if (!tryAdd(text, [item.id])) {
        excluded++;
      }
    }
  }

  const relevanceSize = usedChars - relevanceStart;

  return {
    context: sections.join('\n'),
    breakdown: {
      mandatory: mandatorySize,
      session: sessionSize,
      relevance: relevanceSize,
      total: usedChars,
      budget,
      utilizationPct: budget > 0 ? Math.round((usedChars / budget) * 100) : 0,
    },
    includedIds,
    excluded,
  };
}

// ── Layer Builders ──

/**
 * Mandatory layer: corrections + identity + decisions.
 * Always included regardless of session type.
 */
function getMandatoryLayer(db: Database.Database): LayerEntry[] {
  const entries: LayerEntry[] = [];

  // 1. Active corrections (highest priority)
  const corrections = listKnowledge(db, {
    type: 'correction',
    metadataFilter: "json_extract(metadata, '$.graduated_at') IS NULL",
  });

  if (corrections.length > 0) {
    // Group by correction_type, ordered by priority
    const typeOrder = ['policy', 'fact', 'pattern', 'technical'];
    const grouped = new Map<string, Knowledge[]>();

    for (const c of corrections) {
      const ct = (c.metadata.correction_type as string) ?? 'other';
      if (!grouped.has(ct)) grouped.set(ct, []);
      grouped.get(ct)!.push(c);
    }

    let correctionText = '# Corrections\n';
    for (const type of typeOrder) {
      const items = grouped.get(type);
      if (!items || items.length === 0) continue;
      const perm = items[0].metadata.permanence === 'never' ? ' (permanent)' : '';
      correctionText += `\n## ${type.charAt(0).toUpperCase() + type.slice(1)}${perm}\n`;
      for (const item of items) {
        const violations = (item.metadata.violation_count as number) ?? 0;
        const violStr = violations > 0 ? ` [${violations} violations]` : '';
        correctionText += `- ${item.content}${violStr}\n`;
      }
    }

    entries.push({
      id: corrections.map(c => c.id).join(','),
      header: '# Corrections',
      content: correctionText,
      priority: 0,
    });
  }

  // 2. Core identity
  const identity = getKnowledgeByKey(db, 'context', 'identity');
  if (identity) {
    entries.push({
      id: identity.id,
      header: '# Identity',
      content: identity.content,
      priority: 1,
    });
  }

  // 3. Key decisions
  const decisions = getKnowledgeByKey(db, 'context', 'decisions');
  if (decisions) {
    entries.push({
      id: decisions.id,
      header: '# Key Decisions',
      content: decisions.content,
      priority: 2,
    });
  }

  return entries.sort((a, b) => a.priority - b.priority);
}

/**
 * Session layer: varies by session type.
 */
function getSessionLayer(db: Database.Database, sessionType: SessionType): LayerEntry[] {
  const entries: LayerEntry[] = [];
  const layerConfig = SESSION_LAYERS[sessionType] ?? [];

  for (const item of layerConfig) {
    if (item.key) {
      // Specific key lookup
      const knowledge = getKnowledgeByKey(db, item.type, item.key);
      if (knowledge) {
        entries.push({
          id: knowledge.id,
          header: item.header,
          content: knowledge.content,
          priority: item.priority,
        });
      }
    } else {
      // Type-based listing with optional metadata filter
      const items = listKnowledge(db, {
        type: item.type,
        metadataFilter: item.metadataFilter,
        limit: item.limit ?? 50,
      });

      if (items.length > 0) {
        const content = items.map(k => {
          const conf = k.metadata.confidence !== undefined
            ? ` (${Math.round((k.metadata.confidence as number) * 100)}%)`
            : '';
          return `- ${k.content}${conf}`;
        }).join('\n');

        entries.push({
          id: items.map(k => k.id).join(','),
          header: item.header,
          content: content,
          priority: item.priority,
        });
      }
    }
  }

  return entries.sort((a, b) => a.priority - b.priority);
}

// ── Formatting ──

function formatEntry(entry: LayerEntry, includeHeaders: boolean): string {
  if (includeHeaders && entry.header) {
    // If the content already starts with a markdown header, don't add another
    if (entry.content.startsWith('#')) {
      return `\n${entry.content}\n`;
    }
    return `\n${entry.header}\n${entry.content}\n`;
  }
  return `\n${entry.content}\n`;
}
