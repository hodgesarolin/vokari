import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export type CorrectionType = 'fact' | 'pattern' | 'policy' | 'technical';
export type Permanence = 'never' | 'conditional' | 'graduable';

export interface Correction {
  id: string;
  type: CorrectionType;
  content: string;
  root_cause: string | null;
  example_bad: string | null;
  example_good: string | null;
  permanence: Permanence;
  created_at: string;
  last_violated: string | null;
  violation_count: number;
  streak_days: number;
  graduation_eligible: string | null;
  graduated_at: string | null;
  source: string | null;
}

export interface AddCorrectionInput {
  type: CorrectionType;
  content: string;
  root_cause?: string;
  example_bad?: string;
  example_good?: string;
  permanence?: Permanence;
  source?: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS corrections (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('fact', 'pattern', 'policy', 'technical')),
    content TEXT NOT NULL,
    root_cause TEXT,
    example_bad TEXT,
    example_good TEXT,
    permanence TEXT DEFAULT 'conditional'
      CHECK (permanence IN ('never', 'conditional', 'graduable')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_violated TEXT,
    violation_count INTEGER DEFAULT 0,
    streak_days INTEGER DEFAULT 0,
    graduation_eligible TEXT,
    graduated_at TEXT,
    source TEXT
  );
`;

export function initDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

export function addCorrection(db: Database.Database, input: AddCorrectionInput): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO corrections (id, type, content, root_cause, example_bad, example_good, permanence, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.type,
    input.content,
    input.root_cause ?? null,
    input.example_bad ?? null,
    input.example_good ?? null,
    input.permanence ?? 'conditional',
    input.source ?? null,
  );
  return id;
}

export function getCorrection(db: Database.Database, id: string): Correction | undefined {
  return db.prepare('SELECT * FROM corrections WHERE id = ?').get(id) as Correction | undefined;
}

export function listCorrections(db: Database.Database, opts?: {
  type?: CorrectionType;
  active?: boolean;
}): Correction[] {
  let sql = 'SELECT * FROM corrections WHERE 1=1';
  const params: unknown[] = [];

  if (opts?.type) {
    sql += ' AND type = ?';
    params.push(opts.type);
  }
  if (opts?.active) {
    sql += ' AND graduated_at IS NULL';
  }

  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params) as Correction[];
}

export function recordViolation(db: Database.Database, id: string): void {
  db.prepare(`
    UPDATE corrections
    SET last_violated = datetime('now'),
        violation_count = violation_count + 1,
        streak_days = 0
    WHERE id = ?
  `).run(id);
}

export function graduateCorrection(db: Database.Database, id: string): void {
  db.prepare(`
    UPDATE corrections
    SET graduated_at = datetime('now')
    WHERE id = ? AND permanence = 'graduable'
  `).run(id);
}

export function deleteCorrection(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM corrections WHERE id = ?').run(id);
}

/**
 * Build a context block of active corrections for system prompt injection.
 * Priority: policy > fact > pattern > technical.
 * Within each type: recent violations first, then by creation date.
 * Truncates to fit within the character budget.
 */
export function getContext(db: Database.Database, budget: number = 4000): string {
  const corrections = db.prepare(`
    SELECT type, content, permanence, violation_count FROM corrections
    WHERE graduated_at IS NULL
    ORDER BY
      CASE type
        WHEN 'policy' THEN 0
        WHEN 'fact' THEN 1
        WHEN 'pattern' THEN 2
        WHEN 'technical' THEN 3
      END,
      CASE WHEN last_violated IS NOT NULL THEN 0 ELSE 1 END,
      violation_count DESC,
      created_at DESC
  `).all() as Pick<Correction, 'type' | 'content' | 'permanence' | 'violation_count'>[];

  let output = '# Active Corrections\n\n';
  let currentType = '';

  for (const c of corrections) {
    const header = c.type !== currentType
      ? `## ${c.type.charAt(0).toUpperCase() + c.type.slice(1)}${c.permanence === 'never' ? ' (permanent)' : ''}\n`
      : '';
    const violation = c.violation_count > 0 ? ` [${c.violation_count} violations]` : '';
    const line = `- ${c.content}${violation}\n`;
    const addition = header + line;

    if (output.length + addition.length > budget) break;
    output += addition;
    currentType = c.type;
  }

  return output;
}

/**
 * Get a summary of correction stats.
 */
export function getStats(db: Database.Database): {
  total: number;
  active: number;
  graduated: number;
  by_type: Record<CorrectionType, number>;
  by_permanence: Record<Permanence, number>;
  total_violations: number;
} {
  const total = (db.prepare('SELECT COUNT(*) as c FROM corrections').get() as { c: number }).c;
  const active = (db.prepare('SELECT COUNT(*) as c FROM corrections WHERE graduated_at IS NULL').get() as { c: number }).c;
  const graduated = total - active;

  const typeRows = db.prepare(
    'SELECT type, COUNT(*) as c FROM corrections WHERE graduated_at IS NULL GROUP BY type'
  ).all() as { type: CorrectionType; c: number }[];
  const by_type = { fact: 0, pattern: 0, policy: 0, technical: 0 };
  for (const r of typeRows) by_type[r.type] = r.c;

  const permRows = db.prepare(
    'SELECT permanence, COUNT(*) as c FROM corrections WHERE graduated_at IS NULL GROUP BY permanence'
  ).all() as { permanence: Permanence; c: number }[];
  const by_permanence = { never: 0, conditional: 0, graduable: 0 };
  for (const r of permRows) by_permanence[r.permanence] = r.c;

  const violations = (db.prepare('SELECT COALESCE(SUM(violation_count), 0) as c FROM corrections').get() as { c: number }).c;

  return { total, active, graduated, by_type, by_permanence, total_violations: violations };
}
