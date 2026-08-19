import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initDb } from '../src/db.js';
import { initKnowledge, addKnowledge, upsertKnowledge, getKnowledgeByKey } from '../src/knowledge.js';
import { proposeMemoryWrite, currentKnowledge, type MemoryProposal } from '../src/proposals.js';

/**
 * Re-initialisation against a database that has ALREADY LIVED.
 *
 * Every other test in this suite builds its database from scratch and initialises it once. That
 * is why a production outage survived five adversarial review rounds and 460 tests: the Vokari
 * MCP server crashed on EVERY startup for five days with
 *
 *     SqliteError: UNIQUE constraint failed: knowledge.type, knowledge.key
 *
 * because `initKnowledge` recreated the pre-migration unique index BEFORE `initProposals` could
 * drop it. On a fresh database the create succeeds and the drop follows harmlessly. The bug
 * needs a database that is already migrated AND holds at least one superseded row — a state no
 * test produced and only production reached.
 *
 * `initKnowledge` runs on every process start, so "does this survive a restart against real
 * data" is the single most load-bearing property in this file, and nothing was asserting it.
 *
 * These tests age a database first, then re-initialise it.
 */

let dir: string;
let dbPath: string;

const proposal = (over: Partial<MemoryProposal> = {}): MemoryProposal => ({
  type: 'belief',
  key: 'k1',
  content: 'the studio runs oMLX',
  source: 'test',
  origin: 'brain',
  confidence: 0.8,
  classification: 'internal',
  volatility: 'slow',
  topics: ['infra'],
  ...over,
});

/** A database carrying every shape production accumulates: history, quarantine, mutable rows. */
function aged(): Database.Database {
  const db = initDb(dbPath);

  // Superseded history — the state that broke startup.
  proposeMemoryWrite(db, proposal({ content: 'port 8080' }));
  proposeMemoryWrite(db, proposal({ content: 'port 35000' }));

  // A quarantined row, which is keyless with its key parked in metadata.
  proposeMemoryWrite(db, proposal({ key: 'held', origin: 'external', content: 'from a web page' }));

  // A mutable row that overwrites rather than appending.
  addKnowledge(db, { type: 'handoff', key: 'h1', content: 'v1', mutable: true });
  upsertKnowledge(db, { type: 'handoff', key: 'h1', content: 'v2' });

  // An immutable row superseded through the deprecated shim rather than a proposal.
  addKnowledge(db, { type: 'note', key: 'n1', content: 'v1', mutable: false });
  upsertKnowledge(db, { type: 'note', key: 'n1', content: 'v2' });

  return db;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vokari-reinit-'));
  dbPath = join(dir, 'epistemic.db');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('re-initialising a database that already has history', () => {
  it('REGRESSION: initKnowledge survives a restart once rows have been superseded', () => {
    // The actual outage. Threw "UNIQUE constraint failed: knowledge.type, knowledge.key".
    const db = aged();
    expect(() => initKnowledge(db)).not.toThrow();
    db.close();
  });

  it('REGRESSION: initDb survives — this is literally what the MCP server does on boot', () => {
    // dist/server.js calls initDb(path) at module load. Every start crashed.
    const db = aged();
    db.close();

    expect(() => {
      const reopened = initDb(dbPath);
      reopened.close();
    }).not.toThrow();
  });

  it('survives repeated restarts, not just the second one', () => {
    const db = aged();
    db.close();
    for (let i = 0; i < 5; i++) {
      const d = initDb(dbPath);
      d.close();
    }
    const d = initDb(dbPath);
    // Assert the COUNT, not the row object: `.get()` returns `{ c: n }`, which is always truthy,
    // so the original assertion could never fail. Caught in review — a test that cannot fail is
    // the same shape as the controls this project keeps finding.
    expect((d.prepare('SELECT COUNT(*) c FROM knowledge').get() as { c: number }).c).toBeGreaterThan(0);
    d.close();
  });

  it('leaves the projection intact across a restart', () => {
    // A restart that "succeeds" but resurrects the wrong row would be worse than a crash.
    let db = aged();
    db.close();
    db = initDb(dbPath);

    expect(currentKnowledge(db, 'belief', 'k1')?.content).toBe('port 35000');
    expect(getKnowledgeByKey(db, 'note', 'n1')?.content).toBe('v2');
    expect(currentKnowledge(db, 'belief', 'held')).toBeUndefined();   // still quarantined
    db.close();
  });

  it('does not resurrect the dropped index on restart', () => {
    // The specific mechanism. Naming it means a reintroduction fails here rather than in
    // production five days later.
    let db = aged();
    db.close();
    db = initDb(dbPath);

    const names = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='knowledge'",
    ).all() as { name: string }[]).map((r) => r.name);

    expect(names).toContain('idx_knowledge_current');
    expect(names).not.toContain('idx_knowledge_type_key');
    db.close();
  });

  it('still enforces one current row per key after a restart', () => {
    // Dropping the old index must not mean dropping the invariant.
    let db = aged();
    db.close();
    db = initDb(dbPath);

    expect(() => {
      db.prepare(
        "INSERT INTO knowledge (id, type, key, content) VALUES ('dupe', 'belief', 'k1', 'second current row')",
      ).run();
    }).toThrow(/UNIQUE constraint/);
    db.close();
  });

  it('accepts new writes after a restart', () => {
    // Reaching a usable state matters as much as not throwing.
    let db = aged();
    db.close();
    db = initDb(dbPath);

    const d = proposeMemoryWrite(db, proposal({ content: 'port 35100' }));
    expect(d.status).toBe('committed');
    expect(currentKnowledge(db, 'belief', 'k1')?.content).toBe('port 35100');
    db.close();
  });
});

describe('upgrading a database written by the PREVIOUS schema', () => {
  /**
   * The other half of the class: not "already migrated" but "migrating for the first time, with
   * real rows in it". The live store had 1090 rows when the migration first ran, and that path
   * was only ever exercised by hand.
   */
  function preMigration(): void {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE knowledge (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, key TEXT, content TEXT NOT NULL,
        metadata TEXT DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        mutable INTEGER DEFAULT 0
      );
      CREATE UNIQUE INDEX idx_knowledge_type_key ON knowledge(type, key) WHERE key IS NOT NULL;
      CREATE INDEX idx_knowledge_type ON knowledge(type);
    `);
    const ins = db.prepare('INSERT INTO knowledge (id, type, key, content) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < 50; i++) ins.run(`old-${i}`, 'research', `key-${i}`, `content ${i}`);
    db.close();
  }

  it('migrates an old database in place without losing rows', () => {
    preMigration();
    const db = initDb(dbPath);
    expect((db.prepare('SELECT COUNT(*) c FROM knowledge').get() as { c: number }).c).toBe(50);
    expect((db.prepare("SELECT COUNT(*) c FROM knowledge WHERE origin = 'legacy'").get() as { c: number }).c).toBe(50);
    db.close();
  });

  it('then survives a restart, and another, once history accumulates on top', () => {
    // The full production sequence in one test: old schema, migrate, write history, restart.
    preMigration();
    let db = initDb(dbPath);
    proposeMemoryWrite(db, proposal({ type: 'research', key: 'key-0', content: 'revised' }));
    db.close();

    expect(() => { const d = initDb(dbPath); d.close(); }).not.toThrow();

    db = initDb(dbPath);
    expect(currentKnowledge(db, 'research', 'key-0')?.content).toBe('revised');
    db.close();
  });
});

describe('FTS index built over a table that already has rows', () => {
  /**
   * Found by the migration test above rather than by inspection. An external-content FTS5 table
   * holds no text — only an index ASSUMED to mirror `knowledge`. Created over a populated table
   * it is silently empty but believed complete, so search returns nothing (indistinguishable
   * from "no matches"), and the first UPDATE fires a trigger that issues an FTS 'delete' for a
   * row that was never indexed, corrupting the index outright.
   */
  function populatedWithoutFts(): void {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE knowledge (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, key TEXT, content TEXT NOT NULL,
        metadata TEXT DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        mutable INTEGER DEFAULT 0
      );
    `);
    const ins = db.prepare('INSERT INTO knowledge (id, type, key, content) VALUES (?, ?, ?, ?)');
    ins.run('a', 'research', 'ka', 'the studio runs oMLX on port 35100');
    ins.run('b', 'research', 'kb', 'unrelated content about gardening');
    db.close();
  }

  it('backfills, so pre-existing rows are searchable rather than silently invisible', () => {
    populatedWithoutFts();
    const db = initDb(dbPath);
    const hits = db.prepare(
      "SELECT COUNT(*) c FROM knowledge_fts WHERE knowledge_fts MATCH 'oMLX'",
    ).get() as { c: number };
    expect(hits.c).toBe(1);
    db.close();
  });

  it('REGRESSION: updating a pre-existing row does not corrupt the index', () => {
    // Threw "database disk image is malformed" — on an ordinary supersession.
    populatedWithoutFts();
    const db = initDb(dbPath);
    expect(() => proposeMemoryWrite(db, proposal({ type: 'research', key: 'ka', content: 'port 35100 confirmed' })))
      .not.toThrow();

    // An FTS index can be wrong without throwing, so ask it directly.
    expect(() => db.exec("INSERT INTO knowledge_fts(knowledge_fts) VALUES('integrity-check');")).not.toThrow();
    db.close();
  });
});

describe('an FTS index that is ALREADY stale', () => {
  /**
   * Raised in review of this PR. The backfill added above lives inside `if (!ftsExists)`, so it
   * only ever helps a database whose FTS table is created from that moment on. A store where an
   * OLDER version built the index over a populated table keeps a silently empty index forever:
   * `ftsExists` is true on every subsequent boot, the block is skipped, and the corruption
   * landmine stays armed. Preventing the disease in new cases is not the same as curing it.
   */
  function staleIndex(): void {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE knowledge (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, key TEXT, content TEXT NOT NULL,
        metadata TEXT DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        mutable INTEGER DEFAULT 0
      );
    `);
    const ins = db.prepare('INSERT INTO knowledge (id, type, key, content) VALUES (?, ?, ?, ?)');
    ins.run('a', 'research', 'ka', 'the studio runs oMLX on port 35100');
    ins.run('b', 'research', 'kb', 'unrelated content about gardening');

    // The pre-fix behaviour: create the index over populated rows and never backfill.
    db.exec(`
      CREATE VIRTUAL TABLE knowledge_fts USING fts5(
        content, type, key, metadata, content=knowledge, content_rowid=rowid,
        tokenize='porter unicode61'
      );
    `);
    db.close();
  }

  it('is repaired on the next boot, not left silently empty', () => {
    staleIndex();
    // Confirm the state is genuinely broken before init sees it — via MATCH, not COUNT(*).
    // COUNT(*) on an external-content FTS table delegates to the CONTENT table, so it reports the
    // knowledge row count however empty the index is. Using it here was the same mistake the fix
    // itself originally made.
    const pre = new Database(dbPath);
    const preHits = pre.prepare("SELECT COUNT(*) c FROM knowledge_fts WHERE knowledge_fts MATCH 'oMLX'")
      .get() as { c: number };
    expect(preHits.c).toBe(0);
    pre.close();

    const db = initDb(dbPath);
    const hits = db.prepare("SELECT COUNT(*) c FROM knowledge_fts WHERE knowledge_fts MATCH 'oMLX'")
      .get() as { c: number };
    expect(hits.c).toBe(1);
    db.close();
  });

  it('restores the missing triggers, so later writes stay indexed', () => {
    // The assertion that was actually missing. `staleIndex()` builds "FTS table present, triggers
    // absent" — and triggers used to be created only when the TABLE was absent, so that state was
    // never repaired. The startup rebuild made search look correct for one instant and every
    // subsequent write then silently bypassed the index.
    //
    // The previous version of this test asserted only that a write did not throw, which passed
    // against the unfixed code too: with no triggers, nothing fires, so nothing can throw. That
    // is the never-fails shape, and it is why this test now checks the triggers and the index
    // contents rather than the absence of an exception.
    staleIndex();
    const db = initDb(dbPath);

    const triggers = (db.prepare(
      "SELECT COUNT(*) c FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'knowledge'",
    ).get() as { c: number }).c;
    expect(triggers).toBe(3);

    proposeMemoryWrite(db, proposal({ type: 'research', key: 'ka', content: 'revised aardvark' }));

    // The real proof: a write made AFTER the repair is findable. Without triggers this is 0.
    const hits = db.prepare(
      "SELECT COUNT(*) c FROM knowledge_fts WHERE knowledge_fts MATCH 'aardvark'",
    ).get() as { c: number };
    expect(hits.c).toBe(1);
    db.close();
  });

  it('survives the standard repair: dropping the FTS table while triggers remain', () => {
    // The documented operator response to a corrupt FTS5 index is to DROP the table and let it be
    // recreated. That leaves the triggers behind, and CREATE TRIGGER without IF NOT EXISTS then
    // threw "trigger knowledge_ai already exists" on the next boot — turning the standard repair
    // into the same startup outage this PR exists to eliminate.
    const db = aged();
    db.close();

    const surgery = new Database(dbPath);
    surgery.exec('DROP TABLE knowledge_fts;');
    surgery.close();

    expect(() => { const d = initDb(dbPath); d.close(); }).not.toThrow();

    const after = initDb(dbPath);
    const n = after.prepare("SELECT COUNT(*) c FROM knowledge_fts WHERE knowledge_fts MATCH 'port'")
      .get() as { c: number };
    expect(n.c).toBeGreaterThan(0);   // rebuilt, not left empty
    after.close();
  });
});
