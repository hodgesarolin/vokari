import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { resolveId } from './db.js';

export type Domain = 'political' | 'technical' | 'behavioral' | 'market' | 'general';
export type Outcome = 'correct' | 'incorrect' | 'partial' | 'voided';

export interface PredictionRevision {
  previous_prediction: string;
  previous_confidence: number;
  previous_reasoning: string | null;
  reason: string;
  revised_at: string;
}

export interface Prediction {
  id: string;
  topic: string;
  prediction: string;
  confidence: number;
  reasoning: string | null;
  resolution_criteria: string | null;
  check_date: string | null;
  domain: Domain;
  outcome: Outcome | null;
  outcome_notes: string | null;
  resolved_at: string | null;
  created_at: string;
  supersedes: string | null;
  revision_history: PredictionRevision[];
}

export interface AddPredictionInput {
  topic: string;
  prediction: string;
  confidence: number;
  reasoning?: string;
  resolution_criteria?: string;
  check_date?: string;
  domain?: Domain;
  supersedes?: string;
}

export interface ListPredictionsOpts {
  domain?: Domain;
  resolved?: boolean;
  limit?: number;
}

export interface CalibrationOpts {
  domain?: Domain;
}

export interface CalibrationResult {
  total: number;
  correct: number;
  incorrect: number;
  partial: number;
  voided: number;
  accuracy: number;
  average_confidence: number;
  brier_score: number;
  by_domain: Record<Domain, DomainCalibration>;
}

export interface DomainCalibration {
  total: number;
  correct: number;
  accuracy: number;
  average_confidence: number;
  brier_score: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS predictions (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    prediction TEXT NOT NULL,
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    reasoning TEXT,
    resolution_criteria TEXT,
    check_date TEXT,
    domain TEXT DEFAULT 'general'
      CHECK (domain IN ('political', 'technical', 'behavioral', 'market', 'general')),
    outcome TEXT CHECK (outcome IN ('correct', 'incorrect', 'partial', 'voided', NULL)),
    outcome_notes TEXT,
    resolved_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    supersedes TEXT,
    revision_history TEXT DEFAULT '[]'
  );
`;

const INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_predictions_check_date ON predictions(check_date);
  CREATE INDEX IF NOT EXISTS idx_predictions_outcome ON predictions(outcome);
  CREATE INDEX IF NOT EXISTS idx_predictions_domain ON predictions(domain);
`;

/** Safe JSON parse — returns fallback on malformed data. */
function safeJsonParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try { return JSON.parse(json) as T; }
  catch { return fallback; }
}

/** Raw row from SQLite before JSON parsing. */
interface PredictionRow extends Omit<Prediction, 'revision_history'> {
  revision_history: string;
}

function rowToPrediction(row: PredictionRow): Prediction {
  return {
    ...row,
    revision_history: safeJsonParse<PredictionRevision[]>(row.revision_history, []),
  };
}

export function initPredictions(db: Database.Database): void {
  db.exec(SCHEMA);
  db.exec(INDEXES);

  // Migration: add revision_history column to existing databases
  try {
    db.exec(`ALTER TABLE predictions ADD COLUMN revision_history TEXT DEFAULT '[]'`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    if (!msg.includes('duplicate column') && !msg.includes('already exists')) throw err;
  }
}

export function addPrediction(db: Database.Database, input: AddPredictionInput): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO predictions (id, topic, prediction, confidence, reasoning, resolution_criteria, check_date, domain, supersedes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.topic,
    input.prediction,
    input.confidence,
    input.reasoning ?? null,
    input.resolution_criteria ?? null,
    input.check_date ?? null,
    input.domain ?? 'general',
    input.supersedes ?? null,
  );
  return id;
}

export function getPrediction(db: Database.Database, id: string): Prediction | undefined {
  const resolved = resolveId(db, 'predictions', id);
  if (!resolved) return undefined;
  const row = db.prepare('SELECT * FROM predictions WHERE id = ?').get(resolved) as PredictionRow | undefined;
  return row ? rowToPrediction(row) : undefined;
}

export function listPredictions(db: Database.Database, opts?: ListPredictionsOpts): Prediction[] {
  let sql = 'SELECT * FROM predictions WHERE 1=1';
  const params: unknown[] = [];

  if (opts?.domain) {
    sql += ' AND domain = ?';
    params.push(opts.domain);
  }
  if (opts?.resolved === true) {
    sql += ' AND outcome IS NOT NULL';
  } else if (opts?.resolved === false) {
    sql += ' AND outcome IS NULL';
  }

  sql += ' ORDER BY created_at DESC';
  const limit = opts?.limit ?? 100;
  sql += ' LIMIT ?';
  params.push(limit);
  const rows = db.prepare(sql).all(...params) as PredictionRow[];
  return rows.map(rowToPrediction);
}

/**
 * Revise an unresolved prediction in-place. Records the previous state
 * in revision_history for audit trail. Mirrors revise_belief and
 * revise_position patterns.
 *
 * Returns the prediction ID, or undefined if not found or already resolved.
 */
export function revisePrediction(
  db: Database.Database,
  id: string,
  updates: { prediction?: string; confidence?: number; reasoning?: string; reason?: string },
): string | undefined {
  const original = getPrediction(db, id);
  if (!original || original.outcome !== null) return undefined;

  const revision: PredictionRevision = {
    previous_prediction: original.prediction,
    previous_confidence: original.confidence,
    previous_reasoning: original.reasoning,
    reason: updates.reason ?? 'Revised',
    revised_at: new Date().toISOString(),
  };

  const newHistory = [...original.revision_history, revision];

  db.prepare(`
    UPDATE predictions
    SET prediction = ?,
        confidence = ?,
        reasoning = ?,
        revision_history = ?
    WHERE id = ?
  `).run(
    updates.prediction ?? original.prediction,
    updates.confidence ?? original.confidence,
    updates.reasoning ?? original.reasoning,
    JSON.stringify(newHistory),
    original.id,
  );

  return original.id;
}

export function resolvePrediction(
  db: Database.Database,
  id: string,
  outcome: Outcome,
  notes?: string,
): void {
  const resolved = resolveId(db, 'predictions', id);
  if (!resolved) return;
  db.prepare(`
    UPDATE predictions
    SET outcome = ?,
        outcome_notes = ?,
        resolved_at = datetime('now')
    WHERE id = ?
  `).run(outcome, notes ?? null, resolved);
}

export function getPendingReview(db: Database.Database): Prediction[] {
  const rows = db.prepare(`
    SELECT * FROM predictions
    WHERE outcome IS NULL
      AND check_date IS NOT NULL
      AND check_date <= datetime('now')
    ORDER BY check_date ASC
  `).all() as PredictionRow[];
  return rows.map(rowToPrediction);
}

export function getCalibration(db: Database.Database, opts?: CalibrationOpts): CalibrationResult {
  let sql = "SELECT * FROM predictions WHERE outcome IS NOT NULL AND outcome != 'voided'";
  const params: unknown[] = [];

  if (opts?.domain) {
    sql += ' AND domain = ?';
    params.push(opts.domain);
  }

  const resolved = (db.prepare(sql).all(...params) as PredictionRow[]).map(rowToPrediction);

  const allDomains: Domain[] = ['political', 'technical', 'behavioral', 'market', 'general'];
  const by_domain: Record<Domain, DomainCalibration> = {} as Record<Domain, DomainCalibration>;
  for (const d of allDomains) {
    by_domain[d] = { total: 0, correct: 0, accuracy: 0, average_confidence: 0, brier_score: 0 };
  }

  let totalCorrect = 0;
  let totalIncorrect = 0;
  let totalPartial = 0;
  let totalVoided = 0;
  let sumConfidence = 0;
  let sumBrier = 0;

  for (const p of resolved) {
    const outcomeValue = p.outcome === 'correct' ? 1 : p.outcome === 'partial' ? 0.5 : 0;
    const brier = (p.confidence - outcomeValue) ** 2;

    sumConfidence += p.confidence;
    sumBrier += brier;

    if (p.outcome === 'correct') totalCorrect++;
    else if (p.outcome === 'incorrect') totalIncorrect++;
    else if (p.outcome === 'partial') totalPartial++;

    const domainStats = by_domain[p.domain];
    domainStats.total++;
    domainStats.average_confidence += p.confidence;
    domainStats.brier_score += brier;
    if (p.outcome === 'correct') domainStats.correct++;
  }

  // Also count voided separately from the full table
  const voidedSql = opts?.domain
    ? "SELECT COUNT(*) as c FROM predictions WHERE outcome = 'voided' AND domain = ?"
    : "SELECT COUNT(*) as c FROM predictions WHERE outcome = 'voided'";
  const voidedParams: unknown[] = opts?.domain ? [opts.domain] : [];
  totalVoided = (db.prepare(voidedSql).get(...voidedParams) as { c: number }).c;

  const total = resolved.length;

  // Finalize per-domain stats
  for (const d of allDomains) {
    const ds = by_domain[d];
    if (ds.total > 0) {
      ds.accuracy = ds.correct / ds.total;
      ds.brier_score = ds.brier_score / ds.total;
      ds.average_confidence = ds.average_confidence / ds.total;
    }
  }

  return {
    total,
    correct: totalCorrect,
    incorrect: totalIncorrect,
    partial: totalPartial,
    voided: totalVoided,
    accuracy: total > 0 ? totalCorrect / total : 0,
    average_confidence: total > 0 ? sumConfidence / total : 0,
    brier_score: total > 0 ? sumBrier / total : 0,
    by_domain,
  };
}
