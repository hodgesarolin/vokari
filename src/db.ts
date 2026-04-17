import Database from 'better-sqlite3';
import { initBeliefs } from './beliefs.js';
import { initPredictions } from './predictions.js';
import { initPositions } from './positions.js';
import { initVerifications } from './verification.js';
import { initCorrections } from './corrections.js';

const VALID_TABLES = new Set([
  'beliefs', 'corrections', 'predictions', 'positions', 'verifications', 'knowledge',
]);

/**
 * Resolve a potentially truncated ID to a full UUID.
 * Supports exact match (fast path) and prefix matching for truncated IDs
 * (e.g., 8-char prefixes from list_* tool display).
 *
 * Returns the full ID if exactly one match found, undefined otherwise.
 */
export function resolveId(db: Database.Database, table: string, id: string): string | undefined {
  if (!VALID_TABLES.has(table)) throw new Error(`resolveId: invalid table "${table}"`);
  if (!id || id.length < 8) return undefined;

  // Fast path: exact match (full UUID)
  const exact = db.prepare(`SELECT id FROM "${table}" WHERE id = ?`).get(id) as { id: string } | undefined;
  if (exact) return exact.id;

  // Prefix match: only if input looks truncated (no hyphens = likely prefix)
  if (!id.includes('-')) {
    const rows = db.prepare(`SELECT id FROM "${table}" WHERE id LIKE ? LIMIT 2`).all(`${id}%`) as { id: string }[];
    if (rows.length === 1) return rows[0].id;
  }

  return undefined;
}

// ── Migration System ──

/**
 * Run a named migration exactly once. Uses a _migrations table to track
 * which migrations have already been applied. Replaces the old
 * "swallow duplicate column" pattern.
 */
export function runMigration(
  db: Database.Database,
  name: string,
  sql: string,
): boolean {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const exists = db.prepare(
    'SELECT 1 FROM _migrations WHERE name = ?'
  ).get(name);
  if (exists) return false;

  try {
    db.exec(sql);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    // Schema migrations may fail if column/table already exists (fresh DB with updated schema).
    // Mark as applied since the desired state is already in place.
    if (msg.includes('duplicate column') || msg.includes('already exists')) {
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
      return false;
    }
    throw err;
  }

  db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
  return true;
}

export function initDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  initCorrections(db);
  initBeliefs(db);
  initPredictions(db);
  initPositions(db);
  initVerifications(db);
  return db;
}
