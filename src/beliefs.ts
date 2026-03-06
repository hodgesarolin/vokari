/**
 * Belief tracking module for Vokari.
 *
 * SQLite-backed belief store with contradiction detection.
 * Adapted from Brain's beliefs.mjs (which used JSON files).
 *
 * A "belief" is a factual claim or assumption that the system holds about:
 * - The user (preferences, habits, context)
 * - The system (what works, what's broken, performance characteristics)
 * - The world (facts, dates, prices, policies)
 * - Self (meta-observations about the system's own behavior)
 *
 * Each belief tracks confidence, evidence, contradictions, and revision history.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { resolveId } from './db.js';

// ── Types ──

export type BeliefCategory = 'user' | 'system' | 'world' | 'self';
export type BeliefStatus = 'active' | 'challenged' | 'revised' | 'retired';
export type BeliefSensitivity = 'personal' | 'institutional' | 'approximate';

/** Numeric contradiction thresholds by sensitivity level. */
export const SENSITIVITY_THRESHOLDS: Record<BeliefSensitivity, number> = {
  personal: 1.05,       // 5% — income, ages, dates
  institutional: 1.10,  // 10% — school stats, market rates
  approximate: 1.15,    // 15% — population, general stats (default)
};

export interface Contradiction {
  observation: string;
  reason: string;
  recorded_at: string;
}

export interface RevisionEntry {
  previous_statement: string;
  previous_confidence: number;
  reason: string;
  revised_at: string;
}

export interface Belief {
  id: string;
  statement: string;
  category: BeliefCategory;
  confidence: number;
  sensitivity: BeliefSensitivity;
  source: string;
  evidence: string[];
  tags: string[];
  status: BeliefStatus;
  first_recorded: string;
  last_confirmed: string | null;
  contradictions: Contradiction[];
  revision_history: RevisionEntry[];
}

/** Raw row from SQLite before JSON parsing. */
interface BeliefRow {
  id: string;
  statement: string;
  category: BeliefCategory;
  confidence: number;
  sensitivity: BeliefSensitivity;
  source: string;
  evidence: string;
  tags: string;
  status: BeliefStatus;
  first_recorded: string;
  last_confirmed: string | null;
  contradictions: string;
  revision_history: string;
}

export interface AddBeliefInput {
  statement: string;
  category?: BeliefCategory;
  confidence?: number;
  sensitivity?: BeliefSensitivity;
  source?: string;
  evidence?: string[];
  tags?: string[];
}

export interface ListBeliefsOpts {
  category?: BeliefCategory;
  status?: BeliefStatus;
  tags?: string[];
  challengedOnly?: boolean;
}

export interface ObservationMatch {
  belief: Belief;
  relevance: number;
}

export interface ContradictionResult {
  beliefId: string;
  beliefStatement: string;
  observation: string;
  reason: string;
  detectedAt: string;
}

export interface CheckObservationResult {
  matches: ObservationMatch[];
  contradictions: ContradictionResult[];
}

export interface BeliefStats {
  total: number;
  byStatus: Record<BeliefStatus, number>;
  byCategory: Record<BeliefCategory, number>;
  totalContradictions: number;
  challenged: { id: string; statement: string; contradictionCount: number }[];
}

// ── Schema ──

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS beliefs (
    id TEXT PRIMARY KEY,
    statement TEXT NOT NULL,
    category TEXT DEFAULT 'world' CHECK (category IN ('user', 'system', 'world', 'self')),
    confidence REAL DEFAULT 0.7 CHECK (confidence >= 0 AND confidence <= 1),
    sensitivity TEXT DEFAULT 'approximate' CHECK (sensitivity IN ('personal', 'institutional', 'approximate')),
    source TEXT DEFAULT 'observation',
    evidence TEXT DEFAULT '[]',
    tags TEXT DEFAULT '[]',
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'challenged', 'revised', 'retired')),
    first_recorded TEXT NOT NULL DEFAULT (datetime('now')),
    last_confirmed TEXT,
    contradictions TEXT DEFAULT '[]',
    revision_history TEXT DEFAULT '[]'
  );
`;

const MIGRATIONS = [
  // Add sensitivity column if it doesn't exist (for existing databases)
  `ALTER TABLE beliefs ADD COLUMN sensitivity TEXT DEFAULT 'approximate' CHECK (sensitivity IN ('personal', 'institutional', 'approximate'))`,
];

// ── Helpers ──

/** Parse a SQLite row's JSON fields into a typed Belief object. */
function rowToBelief(row: BeliefRow): Belief {
  return {
    ...row,
    evidence: JSON.parse(row.evidence) as string[],
    tags: JSON.parse(row.tags) as string[],
    contradictions: JSON.parse(row.contradictions) as Contradiction[],
    revision_history: JSON.parse(row.revision_history) as RevisionEntry[],
  };
}

// ── Stop words for relevance scoring ──

const STOP_WORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'have', 'been',
  'about', 'would', 'could', 'should', 'their', 'there', 'where',
  'which', 'these', 'those', 'other', 'after', 'before', 'while',
]);

// ── Core Functions ──

/**
 * Initialize the beliefs table and run any pending migrations.
 */
export function initBeliefs(db: Database.Database): void {
  db.exec(SCHEMA);

  // Run migrations for existing databases
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch {
      // Column/constraint already exists — safe to ignore
    }
  }
}

/**
 * Add a new belief to the store.
 * Returns the generated ID.
 */
export function addBelief(db: Database.Database, input: AddBeliefInput): string {
  const id = randomUUID();
  const confidence = Math.max(0, Math.min(1, input.confidence ?? 0.7));

  db.prepare(`
    INSERT INTO beliefs (id, statement, category, confidence, sensitivity, source, evidence, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.statement,
    input.category ?? 'world',
    confidence,
    input.sensitivity ?? 'approximate',
    input.source ?? 'observation',
    JSON.stringify(input.evidence ?? []),
    JSON.stringify(input.tags ?? []),
  );

  return id;
}

/**
 * Get a single belief by ID, with JSON fields parsed.
 */
export function getBelief(db: Database.Database, id: string): Belief | undefined {
  const resolved = resolveId(db, 'beliefs', id);
  if (!resolved) return undefined;
  const row = db.prepare('SELECT * FROM beliefs WHERE id = ?').get(resolved) as BeliefRow | undefined;
  return row ? rowToBelief(row) : undefined;
}

/**
 * List beliefs with optional filtering.
 */
export function listBeliefs(db: Database.Database, opts?: ListBeliefsOpts): Belief[] {
  let sql = 'SELECT * FROM beliefs WHERE 1=1';
  const params: unknown[] = [];

  if (opts?.category) {
    sql += ' AND category = ?';
    params.push(opts.category);
  }
  if (opts?.status) {
    sql += ' AND status = ?';
    params.push(opts.status);
  }
  if (opts?.challengedOnly) {
    sql += " AND status = 'challenged'";
  }
  if (opts?.tags && opts.tags.length > 0) {
    // Match beliefs that contain any of the specified tags in the JSON array
    const tagClauses = opts.tags.map(() => "tags LIKE ?");
    sql += ` AND (${tagClauses.join(' OR ')})`;
    for (const tag of opts.tags) {
      params.push(`%"${tag}"%`);
    }
  }

  sql += ' ORDER BY first_recorded DESC';
  const rows = db.prepare(sql).all(...params) as BeliefRow[];
  return rows.map(rowToBelief);
}

/**
 * Check an observation against existing beliefs.
 * Uses word-overlap relevance scoring with negation and numeric conflict detection.
 *
 * Returns matches (beliefs related to the observation) and any contradictions detected.
 */
export function checkObservation(
  db: Database.Database,
  observation: string,
  category?: BeliefCategory,
  tags?: string[],
): CheckObservationResult {
  // Get active and challenged beliefs
  let sql = "SELECT * FROM beliefs WHERE status IN ('active', 'challenged')";
  const params: unknown[] = [];

  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }
  if (tags && tags.length > 0) {
    const tagClauses = tags.map(() => "tags LIKE ?");
    sql += ` AND (${tagClauses.join(' OR ')})`;
    for (const tag of tags) {
      params.push(`%"${tag}"%`);
    }
  }

  const rows = db.prepare(sql).all(...params) as BeliefRow[];
  const candidates = rows.map(rowToBelief);

  const obsLower = observation.toLowerCase();
  const obsWords = new Set(obsLower.split(/\s+/).filter(w => w.length > 3));

  const matches: ObservationMatch[] = [];
  const contradictions: ContradictionResult[] = [];

  for (const belief of candidates) {
    const belWords = new Set(
      belief.statement.toLowerCase().split(/\s+/).filter(w => w.length > 3)
    );

    // Calculate word overlap as relevance score
    let overlap = 0;
    for (const word of obsWords) {
      if (belWords.has(word)) overlap++;
    }

    const relevance = belWords.size > 0 ? overlap / belWords.size : 0;

    if (relevance >= 0.2) {
      matches.push({ belief, relevance });

      // Check for contradiction signals (use belief's sensitivity for threshold)
      const hasNegation = containsNegation(observation, belief.statement);
      const hasConflicting = hasConflictingNumericValues(
        observation,
        belief.statement,
        belief.sensitivity,
      );

      if (hasNegation || hasConflicting) {
        contradictions.push({
          beliefId: belief.id,
          beliefStatement: belief.statement,
          observation,
          reason: hasNegation ? 'negation_detected' : 'conflicting_values',
          detectedAt: new Date().toISOString(),
        });
      }
    }
  }

  // Sort matches by relevance descending
  matches.sort((a, b) => b.relevance - a.relevance);

  return { matches, contradictions };
}

/**
 * Record a contradiction against a belief.
 * Pushes to the contradictions array and auto-challenges at 2+ contradictions.
 */
export function recordContradiction(
  db: Database.Database,
  beliefId: string,
  observation: string,
  reason?: string,
): Belief | undefined {
  const belief = getBelief(db, beliefId);
  if (!belief) return undefined;

  const newContradiction: Contradiction = {
    observation,
    reason: reason ?? 'manual',
    recorded_at: new Date().toISOString(),
  };

  const updatedContradictions = [...belief.contradictions, newContradiction];

  // Auto-challenge beliefs with 2+ contradictions
  const newStatus = updatedContradictions.length >= 2 && belief.status === 'active'
    ? 'challenged'
    : belief.status;

  db.prepare(`
    UPDATE beliefs
    SET contradictions = ?,
        status = ?
    WHERE id = ?
  `).run(
    JSON.stringify(updatedContradictions),
    newStatus,
    belief.id,
  );

  return getBelief(db, belief.id);
}

/**
 * Confirm a belief — update last_confirmed and optionally add evidence.
 * If the belief was challenged, restore to active and boost confidence by 0.1.
 */
export function confirmBelief(
  db: Database.Database,
  beliefId: string,
  evidence?: string,
): Belief | undefined {
  const belief = getBelief(db, beliefId);
  if (!belief) return undefined;

  const updatedEvidence = evidence
    ? [...belief.evidence, evidence]
    : belief.evidence;

  // If challenged, restore to active and boost confidence
  const newStatus = belief.status === 'challenged' ? 'active' : belief.status;
  const newConfidence = belief.status === 'challenged'
    ? Math.min(1.0, belief.confidence + 0.1)
    : belief.confidence;

  db.prepare(`
    UPDATE beliefs
    SET last_confirmed = datetime('now'),
        evidence = ?,
        status = ?,
        confidence = ?
    WHERE id = ?
  `).run(
    JSON.stringify(updatedEvidence),
    newStatus,
    newConfidence,
    belief.id,
  );

  return getBelief(db, belief.id);
}

/**
 * Revise a belief — update statement, append to revision_history,
 * clear contradictions, and reset status to active.
 */
export function reviseBelief(
  db: Database.Database,
  beliefId: string,
  newStatement: string,
  reason: string,
  newConfidence?: number,
): Belief | undefined {
  const belief = getBelief(db, beliefId);
  if (!belief) return undefined;

  const revision: RevisionEntry = {
    previous_statement: belief.statement,
    previous_confidence: belief.confidence,
    reason,
    revised_at: new Date().toISOString(),
  };

  const updatedHistory = [...belief.revision_history, revision];
  const confidence = newConfidence !== undefined
    ? Math.max(0, Math.min(1, newConfidence))
    : belief.confidence;

  db.prepare(`
    UPDATE beliefs
    SET statement = ?,
        confidence = ?,
        status = 'active',
        last_confirmed = datetime('now'),
        contradictions = '[]',
        revision_history = ?
    WHERE id = ?
  `).run(
    newStatement,
    confidence,
    JSON.stringify(updatedHistory),
    belief.id,
  );

  return getBelief(db, belief.id);
}

/**
 * Retire a belief — mark as no longer relevant.
 */
export function retireBelief(
  db: Database.Database,
  beliefId: string,
  reason: string,
): Belief | undefined {
  const belief = getBelief(db, beliefId);
  if (!belief) return undefined;

  const revision: RevisionEntry = {
    previous_statement: belief.statement,
    previous_confidence: belief.confidence,
    reason: `Retired: ${reason}`,
    revised_at: new Date().toISOString(),
  };

  const updatedHistory = [...belief.revision_history, revision];

  db.prepare(`
    UPDATE beliefs
    SET status = 'retired',
        revision_history = ?
    WHERE id = ?
  `).run(
    JSON.stringify(updatedHistory),
    belief.id,
  );

  return getBelief(db, belief.id);
}

/**
 * Get formatted beliefs as markdown for system prompt injection.
 * Groups by category, truncates to fit within the character budget.
 */
export function getBeliefContext(db: Database.Database, budget: number = 4000): string {
  const rows = db.prepare(`
    SELECT * FROM beliefs
    WHERE status IN ('active', 'challenged')
    ORDER BY
      CASE category
        WHEN 'user' THEN 0
        WHEN 'system' THEN 1
        WHEN 'world' THEN 2
        WHEN 'self' THEN 3
      END,
      confidence DESC,
      first_recorded DESC
  `).all() as BeliefRow[];

  const beliefs = rows.map(rowToBelief);

  if (beliefs.length === 0) return '# Beliefs\n\nNo active beliefs recorded.';

  let output = '# Beliefs\n\n';
  let currentCategory = '';

  const categoryLabels: Record<string, string> = {
    user: 'About the User',
    system: 'About the System',
    world: 'About the World',
    self: 'About Self',
  };

  for (const b of beliefs) {
    const header = b.category !== currentCategory
      ? `## ${categoryLabels[b.category] ?? b.category}\n`
      : '';

    const statusMarker = b.status === 'challenged' ? ' [CHALLENGED]' : '';
    const confidenceStr = `${Math.round(b.confidence * 100)}%`;
    const line = `- ${b.statement} (${confidenceStr})${statusMarker}\n`;
    const addition = header + line;

    if (output.length + addition.length > budget) break;
    output += addition;
    currentCategory = b.category;
  }

  return output;
}

/**
 * Get summary statistics about the belief store.
 */
export function getBeliefStats(db: Database.Database): BeliefStats {
  const rows = db.prepare('SELECT * FROM beliefs').all() as BeliefRow[];
  const beliefs = rows.map(rowToBelief);

  const byStatus: Record<BeliefStatus, number> = { active: 0, challenged: 0, revised: 0, retired: 0 };
  const byCategory: Record<BeliefCategory, number> = { user: 0, system: 0, world: 0, self: 0 };
  let totalContradictions = 0;

  for (const b of beliefs) {
    byStatus[b.status]++;
    byCategory[b.category]++;
    totalContradictions += b.contradictions.length;
  }

  const challenged = beliefs
    .filter(b => b.status === 'challenged')
    .map(b => ({
      id: b.id,
      statement: b.statement,
      contradictionCount: b.contradictions.length,
    }));

  return {
    total: beliefs.length,
    byStatus,
    byCategory,
    totalContradictions,
    challenged,
  };
}

// ── Contradiction Detection Helpers ──

/**
 * Check if an observation contains a negation of a belief statement.
 * Looks for negation patterns near shared key terms.
 */
export function containsNegation(observation: string, beliefStatement: string): boolean {
  const obsLower = observation.toLowerCase();
  const belLower = beliefStatement.toLowerCase();

  // Extract key terms from belief (words > 4 chars, not stop words)
  const keyTerms = belLower
    .split(/\s+/)
    .filter(w => w.length > 4 && !STOP_WORDS.has(w));

  const negationPatterns = [
    /\bnot\b/,
    /\bno longer\b/,
    /\bisn't\b/,
    /\bdoesn't\b/,
    /\bwon't\b/,
    /\bdon't\b/,
    /\bnever\b/,
    /\bno\b/,
    /\bstopped\b/,
    /\bchanged from\b/,
    /\binstead of\b/,
    /\breplaced\b/,
    /\bremoved\b/,
  ];

  const hasNegation = negationPatterns.some(p => p.test(obsLower));
  const hasSharedTerms = keyTerms.some(term => obsLower.includes(term));

  return hasNegation && hasSharedTerms;
}

/**
 * Check if observation and belief contain conflicting numeric values.
 * Extracts numbers (with optional $, ~, K/M/B suffixes) and checks against
 * the sensitivity threshold.
 *
 * @param sensitivity Controls how tight the comparison is:
 *   - 'personal' (5%): for income, ages, dates — catches $105 vs $96
 *   - 'institutional' (10%): for school stats, market rates
 *   - 'approximate' (15%, default): for population, general stats
 */
export function hasConflictingNumericValues(
  observation: string,
  beliefStatement: string,
  sensitivity: BeliefSensitivity = 'approximate',
): boolean {
  const numPattern = /[$~]?\d[\d,]*\.?\d*[KMB]?/gi;

  const obsNums = observation.match(numPattern);
  const belNums = beliefStatement.match(numPattern);

  if (!obsNums || !belNums) return false;

  const obsClean = obsNums.map(n => parseApproxNumber(n));
  const belClean = belNums.map(n => parseApproxNumber(n));

  // Only flag if there's exactly one number in each and they differ significantly
  if (obsClean.length === 1 && belClean.length === 1) {
    const min = Math.min(obsClean[0], belClean[0]);
    if (min === 0) return obsClean[0] !== belClean[0];
    const ratio = Math.max(obsClean[0], belClean[0]) / min;
    const threshold = SENSITIVITY_THRESHOLDS[sensitivity];
    return ratio > threshold;
  }

  return false;
}

/**
 * Parse an approximate number from a string like "$1.27M", "~500K", "128".
 * Handles dollar signs, tildes, commas, and K/M/B suffixes.
 */
export function parseApproxNumber(str: string): number {
  const clean = str.replace(/[$~,]/g, '');
  const multiplierMatch = clean.match(/[KMB]$/i);
  let num = parseFloat(clean);

  if (multiplierMatch) {
    const m = multiplierMatch[0].toUpperCase();
    if (m === 'K') num *= 1_000;
    else if (m === 'M') num *= 1_000_000;
    else if (m === 'B') num *= 1_000_000_000;
  }

  return isNaN(num) ? 0 : num;
}
