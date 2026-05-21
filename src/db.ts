import Database from 'better-sqlite3';
import { initBeliefs } from './beliefs.js';
import { initPredictions } from './predictions.js';
import { initPositions } from './positions.js';
import { initVerifications } from './verification.js';
import { initCorrections } from './corrections.js';
import { initKnowledge } from './knowledge.js';

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

  // Prefix match: only if input looks truncated (shorter than a full UUID)
  if (id.length < 36) {
    const rows = db.prepare(`SELECT id FROM "${table}" WHERE id LIKE ? LIMIT 2`).all(`${id}%`) as { id: string }[];
    if (rows.length === 1) return rows[0].id;
  }

  return undefined;
}

// ── Timestamp format ──

/**
 * Canonical timestamp format for Vokari. All inserts use SQLite's
 * `datetime('now')` (space-separated, no T/Z). Storing two formats in the
 * same column caused lexical-compare bugs on cooldowns and same-day due
 * items. All code paths now normalize via `now()` or SQL `datetime('now')`.
 */
export function now(): string {
  // Format: 'YYYY-MM-DD HH:MM:SS' (UTC) — matches SQLite's datetime('now').
  return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

// ── Migration System ──

/**
 * Run a named migration exactly once. Uses a _migrations table to track
 * which migrations have already been applied. Atomic: the SQL change and
 * the `_migrations` record go through in the same transaction, so a
 * crash between them can't leave ambiguous state.
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

  const applied = db.transaction(() => {
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
  });
  return applied();
}

/**
 * Initialize the full Vokari schema. Calling this once is the supported
 * library entry point — all six stores (corrections, beliefs, predictions,
 * positions, verifications, knowledge) are created/migrated in order.
 *
 * BRAIN-158 audit: `initKnowledge` was previously missing here, so
 * programmatic consumers calling `upsertKnowledge` after `initDb` hit
 * missing-table errors unless they knew to call it separately. The MCP
 * server and CLI worked around this manually; the library no longer
 * requires that.
 */
export function initDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  initCorrections(db);
  initBeliefs(db);
  initPredictions(db);
  initPositions(db);
  initVerifications(db);
  initKnowledge(db);
  return db;
}
