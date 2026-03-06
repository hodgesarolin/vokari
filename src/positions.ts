import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { resolveId } from './db.js';

export type PositionStatus = 'held' | 'challenged' | 'revised' | 'abandoned';

export interface RevisionEntry {
  date: string;
  old_position: string;
  old_confidence: number;
  reason: string;
}

export interface Position {
  id: string;
  topic: string;
  position: string;
  reasoning: string | null;
  evidence: string | null;
  confidence: number | null;
  status: PositionStatus;
  created_at: string;
  last_challenged: string | null;
  challenge_count: number;
  revision_history: string | null;
  supersedes: string | null;
  counterevidence: string | null;
}

export interface AddPositionInput {
  topic: string;
  position: string;
  reasoning?: string;
  evidence?: string[];
  confidence?: number;
  supersedes?: string;
  counterevidence?: string[];
}

export interface ListPositionsOpts {
  status?: PositionStatus;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS positions (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    position TEXT NOT NULL,
    reasoning TEXT,
    evidence TEXT,
    confidence REAL CHECK (confidence >= 0 AND confidence <= 1),
    status TEXT DEFAULT 'held'
      CHECK (status IN ('held', 'challenged', 'revised', 'abandoned')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_challenged TEXT,
    challenge_count INTEGER DEFAULT 0,
    revision_history TEXT,
    supersedes TEXT,
    counterevidence TEXT
  );
`;

export function initPositions(db: Database.Database): void {
  db.exec(SCHEMA);
}

export function addPosition(db: Database.Database, input: AddPositionInput): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO positions (id, topic, position, reasoning, evidence, confidence, supersedes, counterevidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.topic,
    input.position,
    input.reasoning ?? null,
    input.evidence ? JSON.stringify(input.evidence) : null,
    input.confidence ?? null,
    input.supersedes ?? null,
    input.counterevidence ? JSON.stringify(input.counterevidence) : null,
  );
  return id;
}

export function getPosition(db: Database.Database, id: string): Position | undefined {
  const resolved = resolveId(db, 'positions', id);
  if (!resolved) return undefined;
  return db.prepare('SELECT * FROM positions WHERE id = ?').get(resolved) as Position | undefined;
}

export function listPositions(db: Database.Database, opts?: ListPositionsOpts): Position[] {
  let sql = 'SELECT * FROM positions WHERE 1=1';
  const params: unknown[] = [];

  if (opts?.status) {
    sql += ' AND status = ?';
    params.push(opts.status);
  }

  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params) as Position[];
}

export function challengePosition(db: Database.Database, id: string): void {
  const resolved = resolveId(db, 'positions', id);
  if (!resolved) return;
  db.prepare(`
    UPDATE positions
    SET challenge_count = challenge_count + 1,
        last_challenged = datetime('now'),
        status = 'challenged'
    WHERE id = ?
  `).run(resolved);
}

export function revisePosition(
  db: Database.Database,
  id: string,
  newPosition: string,
  newConfidence: number,
  reason: string,
): void {
  const current = getPosition(db, id);
  if (!current) return;

  const history: RevisionEntry[] = current.revision_history
    ? JSON.parse(current.revision_history) as RevisionEntry[]
    : [];

  history.push({
    date: new Date().toISOString(),
    old_position: current.position,
    old_confidence: current.confidence ?? 0,
    reason,
  });

  db.prepare(`
    UPDATE positions
    SET position = ?,
        confidence = ?,
        revision_history = ?,
        status = 'held'
    WHERE id = ?
  `).run(newPosition, newConfidence, JSON.stringify(history), current.id);
}

export function abandonPosition(db: Database.Database, id: string, reason: string): void {
  const current = getPosition(db, id);
  if (!current) return;

  const history: RevisionEntry[] = current.revision_history
    ? JSON.parse(current.revision_history) as RevisionEntry[]
    : [];

  history.push({
    date: new Date().toISOString(),
    old_position: current.position,
    old_confidence: current.confidence ?? 0,
    reason,
  });

  db.prepare(`
    UPDATE positions
    SET status = 'abandoned',
        revision_history = ?
    WHERE id = ?
  `).run(JSON.stringify(history), current.id);
}

export function getUnchallenged(db: Database.Database, days: number = 30): Position[] {
  return db.prepare(`
    SELECT * FROM positions
    WHERE status IN ('held', 'challenged')
      AND (
        last_challenged IS NULL
        OR last_challenged <= datetime('now', ? || ' days')
      )
    ORDER BY last_challenged ASC, created_at ASC
  `).all(`-${days}`) as Position[];
}

/**
 * Build a context block of active positions for system prompt injection.
 * Prioritises high-confidence held positions, then challenged positions.
 * Truncates to fit within the character budget.
 */
export function getPositionContext(db: Database.Database, budget: number = 4000): string {
  const positions = db.prepare(`
    SELECT topic, position, confidence, status, challenge_count FROM positions
    WHERE status IN ('held', 'challenged')
    ORDER BY
      CASE status WHEN 'challenged' THEN 0 WHEN 'held' THEN 1 END,
      confidence DESC,
      created_at DESC
  `).all() as Pick<Position, 'topic' | 'position' | 'confidence' | 'status' | 'challenge_count'>[];

  let output = '# Active Positions\n\n';
  let currentStatus = '';

  for (const p of positions) {
    const header = p.status !== currentStatus
      ? `## ${p.status.charAt(0).toUpperCase() + p.status.slice(1)}\n`
      : '';
    const conf = p.confidence !== null ? ` (${Math.round(p.confidence * 100)}%)` : '';
    const challenges = p.challenge_count > 0 ? ` [${p.challenge_count} challenges]` : '';
    const line = `- **${p.topic}**: ${p.position}${conf}${challenges}\n`;
    const addition = header + line;

    if (output.length + addition.length > budget) break;
    output += addition;
    currentStatus = p.status;
  }

  return output;
}
