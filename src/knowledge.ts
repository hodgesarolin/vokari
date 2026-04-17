/**
 * Unified Knowledge Store for Vokari.
 *
 * Single table that stores ALL content types: beliefs, corrections, positions,
 * predictions, research, handoff, context, archive, etc. Every row has:
 * - Structured fields (type, key, mutable, created_at, updated_at)
 * - Content (the actual text)
 * - Metadata (JSON — confidence, status, evidence, tags, etc.)
 * - FTS5 index (keyword search via triggers)
 *
 * Design principles:
 * - One table, many types. SQL filters narrow by type.
 * - Keyword search across ALL knowledge simultaneously via FTS5.
 * - Mutable rows (handoff) overwrite; immutable rows append/version.
 * - Type is an open string — hosts may write arbitrary types alongside
 *   the documented ones used by Vokari's own modules.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

// ── Types ──

/**
 * Built-in knowledge types. Hosts can extend with custom types via
 * the `string` escape hatch (e.g., 'session', 'ticket', 'daily').
 */
export type KnowledgeType =
  | 'belief'
  | 'correction'
  | 'position'
  | 'prediction'
  | 'research'
  | 'handoff'
  | 'context'
  | 'archive'
  | 'digest'
  | (string & {});  // allow arbitrary host-defined types

// ── Safe SQL Fragments ──
// Branded types prevent raw SQL injection. Only pre-registered fragments are allowed.
// To add a new filter/order, register it in the maps below.

declare const __metadataFilterBrand: unique symbol;
declare const __orderByBrand: unique symbol;

/** Opaque branded type — can only be created via `MetadataFilter()`. */
export type MetadataFilter = string & { readonly [__metadataFilterBrand]: true };
/** Opaque branded type — can only be created via `OrderBy()`. */
export type OrderByExpr = string & { readonly [__orderByBrand]: true };

/**
 * Registry of allowed metadata filter SQL fragments.
 * Keys are semantic names; values are the raw SQL.
 * Add new entries here when new filters are needed.
 */
const METADATA_FILTER_REGISTRY: Record<string, string> = {
  'not_graduated':       "json_extract(metadata, '$.graduated_at') IS NULL",
  'outcome_pending':     "json_extract(metadata, '$.outcome') IS NULL",
  'status_held_or_challenged': "json_extract(metadata, '$.status') IN ('held', 'challenged')",
  'correction_type_policy': "json_extract(metadata, '$.correction_type') = 'policy'",
};

/**
 * Registry of allowed ORDER BY expressions.
 */
const ORDER_BY_REGISTRY: Record<string, string> = {
  'updated_desc':  'updated_at DESC',
  'updated_asc':   'updated_at ASC',
  'created_desc':  'created_at DESC',
  'created_asc':   'created_at ASC',
};

/**
 * Create a safe MetadataFilter from a registered name.
 * Throws if the name is not in the registry.
 */
export function MetadataFilter(name: string): MetadataFilter {
  const sql = METADATA_FILTER_REGISTRY[name];
  if (!sql) {
    throw new Error(
      `Unknown metadata filter: "${name}". Registered filters: ${Object.keys(METADATA_FILTER_REGISTRY).join(', ')}`
    );
  }
  return sql as MetadataFilter;
}

/**
 * Create a safe OrderByExpr from a registered name.
 * Throws if the name is not in the registry.
 */
export function OrderBy(name: string): OrderByExpr {
  const sql = ORDER_BY_REGISTRY[name];
  if (!sql) {
    throw new Error(
      `Unknown order-by expression: "${name}". Registered: ${Object.keys(ORDER_BY_REGISTRY).join(', ')}`
    );
  }
  return sql as OrderByExpr;
}

export interface KnowledgeRow {
  id: string;
  type: KnowledgeType;
  key: string | null;
  content: string;
  metadata: string; // JSON string
  created_at: string;
  updated_at: string;
  mutable: number; // 0 or 1
}

export interface Knowledge {
  id: string;
  type: KnowledgeType;
  key: string | null;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  mutable: boolean;
}

export interface AddKnowledgeInput {
  type: KnowledgeType;
  key?: string;
  content: string;
  metadata?: Record<string, unknown>;
  mutable?: boolean;
}

export interface UpsertKnowledgeInput {
  type: KnowledgeType;
  key: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface SearchKnowledgeOpts {
  type?: KnowledgeType;
  types?: KnowledgeType[];
  limit?: number;
  dateAfter?: string;
  dateBefore?: string;
}

export interface KnowledgeSearchResult extends Knowledge {
  rank: number;
  snippet: string;
}


export interface KnowledgeStats {
  total: number;
  byType: { type: string; count: number }[];
  mutableCount: number;
}

// ── Schema ──

const KNOWLEDGE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS knowledge (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    key TEXT,
    content TEXT NOT NULL,
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    mutable INTEGER DEFAULT 0
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_type_key
    ON knowledge(type, key) WHERE key IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_knowledge_type
    ON knowledge(type);

  CREATE INDEX IF NOT EXISTS idx_knowledge_updated
    ON knowledge(updated_at);
`;

/**
 * Initialize the knowledge table, FTS5 index, and triggers.
 * Safe to call multiple times — uses IF NOT EXISTS.
 */
export function initKnowledge(db: Database.Database): void {
  db.exec(KNOWLEDGE_SCHEMA);

  // FTS5 virtual table — external content mode.
  // Note: knowledge.id is a TEXT UUID, but FTS5 content_rowid uses SQLite's
  // implicit integer rowid. Hybrid search must JOIN on rowid, not id.
  const ftsExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_fts'"
  ).get();

  if (!ftsExists) {
    db.exec(`
      CREATE VIRTUAL TABLE knowledge_fts USING fts5(
        content,
        type,
        key,
        metadata,
        content=knowledge,
        content_rowid=rowid,
        tokenize='porter unicode61'
      );

      CREATE TRIGGER knowledge_ai AFTER INSERT ON knowledge BEGIN
        INSERT INTO knowledge_fts(rowid, content, type, key, metadata)
          VALUES (new.rowid, new.content, new.type, new.key, new.metadata);
      END;

      CREATE TRIGGER knowledge_ad AFTER DELETE ON knowledge BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, content, type, key, metadata)
          VALUES ('delete', old.rowid, old.content, old.type, old.key, old.metadata);
      END;

      CREATE TRIGGER knowledge_au AFTER UPDATE ON knowledge BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, content, type, key, metadata)
          VALUES ('delete', old.rowid, old.content, old.type, old.key, old.metadata);
        INSERT INTO knowledge_fts(rowid, content, type, key, metadata)
          VALUES (new.rowid, new.content, new.type, new.key, new.metadata);
      END;
    `);
  }
}

// ── Helpers ──

function rowToKnowledge(row: KnowledgeRow): Knowledge {
  return {
    ...row,
    metadata: JSON.parse(row.metadata || '{}') as Record<string, unknown>,
    mutable: row.mutable === 1,
  };
}

// ── Core CRUD ──

/**
 * Add a knowledge row. Returns the generated UUID.
 */
export function addKnowledge(db: Database.Database, input: AddKnowledgeInput): string {
  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO knowledge (id, type, key, content, metadata, created_at, updated_at, mutable)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.type,
    input.key ?? null,
    input.content,
    JSON.stringify(input.metadata ?? {}),
    now,
    now,
    input.mutable ? 1 : 0,
  );

  return id;
}

/**
 * Get a knowledge row by ID.
 */
export function getKnowledge(db: Database.Database, id: string): Knowledge | undefined {
  const row = db.prepare('SELECT * FROM knowledge WHERE id = ?').get(id) as KnowledgeRow | undefined;
  return row ? rowToKnowledge(row) : undefined;
}

/**
 * Get a knowledge row by type + key.
 */
export function getKnowledgeByKey(
  db: Database.Database,
  type: KnowledgeType,
  key: string,
): Knowledge | undefined {
  const row = db.prepare(
    'SELECT * FROM knowledge WHERE type = ? AND key = ?'
  ).get(type, key) as KnowledgeRow | undefined;
  return row ? rowToKnowledge(row) : undefined;
}

export interface ListKnowledgeOpts {
  type?: KnowledgeType;
  types?: KnowledgeType[];
  mutable?: boolean;
  limit?: number;
  orderBy?: OrderByExpr;
}

/**
 * Options for internal list queries that support metadata filtering.
 * The MetadataFilter branded type ensures only registered SQL fragments are used.
 */
export interface ListKnowledgeInternalOpts extends ListKnowledgeOpts {
  metadataFilter?: MetadataFilter;
}

/**
 * List knowledge rows with optional filtering.
 * Safe for use with untrusted input — no raw SQL interpolation.
 */
export function listKnowledge(
  db: Database.Database,
  opts?: ListKnowledgeOpts,
): Knowledge[] {
  return listKnowledgeInternal(db, opts);
}

/**
 * Internal list function that supports metadata filtering via branded types.
 * MetadataFilter and OrderByExpr can only be created from registered SQL
 * fragments, preventing SQL injection at the type level.
 *
 * @internal
 */
export function listKnowledgeInternal(
  db: Database.Database,
  opts?: ListKnowledgeInternalOpts,
): Knowledge[] {
  let sql = 'SELECT * FROM knowledge WHERE 1=1';
  const params: unknown[] = [];

  if (opts?.type) {
    sql += ' AND type = ?';
    params.push(opts.type);
  }
  if (opts?.types && opts.types.length > 0) {
    sql += ` AND type IN (${opts.types.map(() => '?').join(',')})`;
    params.push(...opts.types);
  }
  if (opts?.mutable !== undefined) {
    sql += ' AND mutable = ?';
    params.push(opts.mutable ? 1 : 0);
  }
  if (opts?.metadataFilter) {
    sql += ` AND ${opts.metadataFilter}`;
  }

  sql += ` ORDER BY ${opts?.orderBy ?? 'updated_at DESC'}`;

  if (opts?.limit) {
    sql += ' LIMIT ?';
    params.push(opts.limit);
  }

  const rows = db.prepare(sql).all(...params) as KnowledgeRow[];
  return rows.map(rowToKnowledge);
}

/**
 * Update a knowledge row's content and/or metadata.
 */
export function updateKnowledge(
  db: Database.Database,
  id: string,
  updates: { content?: string; metadata?: Record<string, unknown> },
): Knowledge | undefined {
  const txn = db.transaction(() => {
    const existing = getKnowledge(db, id);
    if (!existing) return undefined;

    const now = new Date().toISOString();
    const newContent = updates.content ?? existing.content;
    const newMetadata = updates.metadata
      ? JSON.stringify(updates.metadata)
      : JSON.stringify(existing.metadata);

    db.prepare(`
      UPDATE knowledge
      SET content = ?, metadata = ?, updated_at = ?
      WHERE id = ?
    `).run(newContent, newMetadata, now, id);

    return getKnowledge(db, id);
  });
  return txn();
}

/**
 * Upsert: for mutable types (handoff, context), overwrite on type+key match.
 * For immutable types, creates a new row.
 *
 * Returns the ID of the upserted row.
 */
export function upsertKnowledge(
  db: Database.Database,
  input: UpsertKnowledgeInput,
): string {
  const txn = db.transaction(() => {
    const now = new Date().toISOString();
    const metadataStr = JSON.stringify(input.metadata ?? {});

    // Try to find existing row by type + key
    const existing = db.prepare(
      'SELECT id, mutable FROM knowledge WHERE type = ? AND key = ?'
    ).get(input.type, input.key) as { id: string; mutable: number } | undefined;

    if (existing) {
      // Update existing row
      db.prepare(`
        UPDATE knowledge
        SET content = ?, metadata = ?, updated_at = ?
        WHERE id = ?
      `).run(input.content, metadataStr, now, existing.id);
      return existing.id;
    }

    // Create new row
    const id = randomUUID();
    // Default: handoff and context types are mutable
    const mutable = input.type === 'handoff' || input.type === 'context' ? 1 : 0;

    db.prepare(`
      INSERT INTO knowledge (id, type, key, content, metadata, created_at, updated_at, mutable)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.type, input.key, input.content, metadataStr, now, now, mutable);

    return id;
  });
  return txn();
}

/**
 * Delete a knowledge row by ID.
 */
export function deleteKnowledge(db: Database.Database, id: string): boolean {
  const result = db.prepare('DELETE FROM knowledge WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Delete all knowledge rows of a given type (and optionally key).
 */
export function deleteKnowledgeByType(
  db: Database.Database,
  type: KnowledgeType,
  key?: string,
): number {
  if (key) {
    return db.prepare('DELETE FROM knowledge WHERE type = ? AND key = ?').run(type, key).changes;
  }
  return db.prepare('DELETE FROM knowledge WHERE type = ?').run(type).changes;
}

// ── FTS5 Search ──

/**
 * Full-text search across the knowledge table.
 * Returns results ranked by BM25, optionally filtered by type.
 */
export function searchKnowledge(
  db: Database.Database,
  queryText: string,
  opts: SearchKnowledgeOpts = {},
): KnowledgeSearchResult[] {
  const { type, types, limit = 10, dateAfter, dateBefore } = opts;

  // Sanitize query for FTS5 — remove all special chars that break MATCH syntax
  const sanitized = queryText
    .replace(/['"]/g, '')
    .replace(/[{}()\[\]^~*:$\/\\@#%&+=<>|!?,;.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!sanitized) return [];

  let sql = `
    SELECT k.id, k.type, k.key, k.content, k.metadata,
           k.created_at, k.updated_at, k.mutable,
           rank,
           snippet(knowledge_fts, 0, '<b>', '</b>', '...', 32) as snippet
    FROM knowledge_fts
    JOIN knowledge k ON knowledge_fts.rowid = k.rowid
    WHERE knowledge_fts MATCH ?
  `;
  const params: (string | number)[] = [sanitized];

  if (type) {
    sql += ` AND k.type = ?`;
    params.push(type);
  }
  if (types && types.length > 0) {
    sql += ` AND k.type IN (${types.map(() => '?').join(',')})`;
    params.push(...types);
  }
  if (dateAfter) {
    sql += ` AND k.created_at >= ?`;
    params.push(dateAfter);
  }
  if (dateBefore) {
    sql += ` AND k.created_at <= ?`;
    params.push(dateBefore);
  }

  sql += ` ORDER BY rank ASC LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as (KnowledgeRow & { rank: number; snippet: string })[];

  return rows.map(row => ({
    ...rowToKnowledge(row),
    rank: row.rank,
    snippet: row.snippet,
  }));
}

// ── Statistics ──

/**
 * Get knowledge store statistics.
 */
export function getKnowledgeStats(db: Database.Database): KnowledgeStats {
  const total = (db.prepare('SELECT COUNT(*) as c FROM knowledge').get() as { c: number }).c;
  const byType = db.prepare(
    'SELECT type, COUNT(*) as count FROM knowledge GROUP BY type ORDER BY count DESC'
  ).all() as { type: string; count: number }[];
  const mutableCount = (db.prepare('SELECT COUNT(*) as c FROM knowledge WHERE mutable = 1').get() as { c: number }).c;

  return { total, byType, mutableCount };
}

// ── Migration Helpers ──

/**
 * Import beliefs from the beliefs table into the knowledge table.
 * Preserves all data by storing belief-specific fields in metadata.
 */
export function importBeliefsToKnowledge(db: Database.Database): number {
  const beliefs = db.prepare(`
    SELECT id, statement, category, confidence, source, evidence, tags,
           status, first_recorded, last_confirmed, contradictions, revision_history
    FROM beliefs
  `).all() as Array<{
    id: string;
    statement: string;
    category: string;
    confidence: number;
    source: string;
    evidence: string;
    tags: string;
    status: string;
    first_recorded: string;
    last_confirmed: string | null;
    contradictions: string;
    revision_history: string;
  }>;

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO knowledge (id, type, key, content, metadata, created_at, updated_at, mutable)
    VALUES (?, 'belief', ?, ?, ?, ?, ?, 0)
  `);

  let count = 0;
  const txn = db.transaction(() => {
    for (const b of beliefs) {
      const metadata = {
        category: b.category,
        confidence: b.confidence,
        source: b.source,
        evidence: JSON.parse(b.evidence),
        tags: JSON.parse(b.tags),
        status: b.status,
        last_confirmed: b.last_confirmed,
        contradictions: JSON.parse(b.contradictions),
        revision_history: JSON.parse(b.revision_history),
      };

      const result = stmt.run(
        b.id,
        `belief-${b.category}-${b.id.slice(0, 8)}`,
        b.statement,
        JSON.stringify(metadata),
        b.first_recorded,
        b.last_confirmed ?? b.first_recorded,
      );
      if (result.changes > 0) count++;
    }
  });

  txn();
  return count;
}

/**
 * Import corrections from the corrections table into the knowledge table.
 */
export function importCorrectionsToKnowledge(db: Database.Database): number {
  const corrections = db.prepare(`
    SELECT id, type, content, root_cause, example_bad, example_good,
           permanence, created_at, last_violated, violation_count,
           streak_days, graduation_eligible, graduated_at, source
    FROM corrections
  `).all() as Array<{
    id: string;
    type: string;
    content: string;
    root_cause: string | null;
    example_bad: string | null;
    example_good: string | null;
    permanence: string;
    created_at: string;
    last_violated: string | null;
    violation_count: number;
    streak_days: number;
    graduation_eligible: string | null;
    graduated_at: string | null;
    source: string | null;
  }>;

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO knowledge (id, type, key, content, metadata, created_at, updated_at, mutable)
    VALUES (?, 'correction', ?, ?, ?, ?, ?, 0)
  `);

  let count = 0;
  const txn = db.transaction(() => {
    for (const c of corrections) {
      const metadata = {
        correction_type: c.type,
        permanence: c.permanence,
        root_cause: c.root_cause,
        example_bad: c.example_bad,
        example_good: c.example_good,
        violation_count: c.violation_count,
        streak_days: c.streak_days,
        graduation_eligible: c.graduation_eligible,
        graduated_at: c.graduated_at,
        last_violated: c.last_violated,
        source: c.source,
      };

      const result = stmt.run(
        c.id,
        `correction-${c.type}-${c.id.slice(0, 8)}`,
        c.content,
        JSON.stringify(metadata),
        c.created_at,
        c.last_violated ?? c.created_at,
      );
      if (result.changes > 0) count++;
    }
  });

  txn();
  return count;
}

/**
 * Import positions from the positions table into the knowledge table.
 */
export function importPositionsToKnowledge(db: Database.Database): number {
  const positions = db.prepare(`
    SELECT id, topic, position, reasoning, evidence, confidence,
           status, created_at, last_challenged, challenge_count,
           revision_history, supersedes, counterevidence
    FROM positions
  `).all() as Array<{
    id: string;
    topic: string;
    position: string;
    reasoning: string | null;
    evidence: string | null;
    confidence: number | null;
    status: string;
    created_at: string;
    last_challenged: string | null;
    challenge_count: number;
    revision_history: string | null;
    supersedes: string | null;
    counterevidence: string | null;
  }>;

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO knowledge (id, type, key, content, metadata, created_at, updated_at, mutable)
    VALUES (?, 'position', ?, ?, ?, ?, ?, 0)
  `);

  let count = 0;
  const txn = db.transaction(() => {
    for (const p of positions) {
      const metadata = {
        topic: p.topic,
        reasoning: p.reasoning,
        evidence: p.evidence ? JSON.parse(p.evidence) : null,
        confidence: p.confidence,
        status: p.status,
        last_challenged: p.last_challenged,
        challenge_count: p.challenge_count,
        revision_history: p.revision_history ? JSON.parse(p.revision_history) : null,
        supersedes: p.supersedes,
        counterevidence: p.counterevidence ? JSON.parse(p.counterevidence) : null,
      };

      // Content = topic + position combined for searchability
      const content = `${p.topic}: ${p.position}`;

      const result = stmt.run(
        p.id,
        `position-${p.id.slice(0, 8)}`,
        content,
        JSON.stringify(metadata),
        p.created_at,
        p.last_challenged ?? p.created_at,
      );
      if (result.changes > 0) count++;
    }
  });

  txn();
  return count;
}

/**
 * Import predictions from the predictions table into the knowledge table.
 */
export function importPredictionsToKnowledge(db: Database.Database): number {
  const predictions = db.prepare(`
    SELECT id, topic, prediction, confidence, reasoning,
           resolution_criteria, check_date, domain, outcome,
           outcome_notes, resolved_at, created_at, supersedes
    FROM predictions
  `).all() as Array<{
    id: string;
    topic: string;
    prediction: string;
    confidence: number;
    reasoning: string | null;
    resolution_criteria: string | null;
    check_date: string | null;
    domain: string;
    outcome: string | null;
    outcome_notes: string | null;
    resolved_at: string | null;
    created_at: string;
    supersedes: string | null;
  }>;

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO knowledge (id, type, key, content, metadata, created_at, updated_at, mutable)
    VALUES (?, 'prediction', ?, ?, ?, ?, ?, 0)
  `);

  let count = 0;
  const txn = db.transaction(() => {
    for (const p of predictions) {
      const metadata = {
        topic: p.topic,
        confidence: p.confidence,
        reasoning: p.reasoning,
        resolution_criteria: p.resolution_criteria,
        check_date: p.check_date,
        domain: p.domain,
        outcome: p.outcome,
        outcome_notes: p.outcome_notes,
        resolved_at: p.resolved_at,
        supersedes: p.supersedes,
      };

      const content = `${p.topic}: ${p.prediction}`;

      const result = stmt.run(
        p.id,
        `prediction-${p.domain}-${p.id.slice(0, 8)}`,
        content,
        JSON.stringify(metadata),
        p.created_at,
        p.resolved_at ?? p.created_at,
      );
      if (result.changes > 0) count++;
    }
  });

  txn();
  return count;
}

/**
 * Import all epistemic data into the knowledge table.
 * Call after initKnowledge() on a DB that has the legacy tables.
 */
export function importAllToKnowledge(db: Database.Database): {
  beliefs: number;
  corrections: number;
  positions: number;
  predictions: number;
  total: number;
} {
  const beliefs = importBeliefsToKnowledge(db);
  const corrections = importCorrectionsToKnowledge(db);
  const positions = importPositionsToKnowledge(db);
  const predictions = importPredictionsToKnowledge(db);

  return {
    beliefs,
    corrections,
    positions,
    predictions,
    total: beliefs + corrections + positions + predictions,
  };
}

