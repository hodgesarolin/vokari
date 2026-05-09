import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  initDb,
  runMigration,
  resolveId,
} from '../src/db.js';
import {
  addCorrection,
  getCorrection,
  listCorrections,
  searchCorrections,
  recordViolation,
  graduateCorrection,
  deleteCorrection,
  getContext,
  getStats,
} from '../src/corrections.js';

let db: Database.Database;

beforeEach(() => {
  db = initDb(':memory:');
});

describe('initDb', () => {
  it('creates the corrections table', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='corrections'"
    ).all();
    expect(tables).toHaveLength(1);
  });

  it('is idempotent', () => {
    // calling initDb again on same db should not throw
    db.exec(`CREATE TABLE IF NOT EXISTS corrections (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('fact', 'pattern', 'policy', 'technical')),
      content TEXT NOT NULL,
      root_cause TEXT,
      example_bad TEXT,
      example_good TEXT,
      permanence TEXT DEFAULT 'conditional',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_violated TEXT,
      violation_count INTEGER DEFAULT 0,
      streak_days INTEGER DEFAULT 0,
      graduation_eligible TEXT,
      graduated_at TEXT,
      source TEXT
    )`);
  });
});

describe('addCorrection', () => {
  it('returns a UUID', () => {
    const id = addCorrection(db, { type: 'fact', content: 'Test correction' });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('stores all fields', () => {
    const id = addCorrection(db, {
      type: 'pattern',
      content: 'Always verify dates',
      root_cause: 'Inferred from timestamps',
      example_bad: 'Today is Tuesday',
      example_good: 'Let me check... today is Wednesday',
      permanence: 'graduable',
      source: 'conversation:123',
    });
    const c = getCorrection(db, id);
    expect(c).toBeDefined();
    expect(c!.type).toBe('pattern');
    expect(c!.content).toBe('Always verify dates');
    expect(c!.root_cause).toBe('Inferred from timestamps');
    expect(c!.example_bad).toBe('Today is Tuesday');
    expect(c!.example_good).toBe('Let me check... today is Wednesday');
    expect(c!.permanence).toBe('graduable');
    expect(c!.source).toBe('conversation:123');
    expect(c!.violation_count).toBe(0);
    expect(c!.streak_days).toBe(0);
  });

  it('defaults permanence to conditional', () => {
    const id = addCorrection(db, { type: 'fact', content: 'Test' });
    const c = getCorrection(db, id);
    expect(c!.permanence).toBe('conditional');
  });

  it('rejects invalid type', () => {
    expect(() =>
      addCorrection(db, { type: 'invalid' as any, content: 'Test' })
    ).toThrow();
  });
});

describe('listCorrections', () => {
  beforeEach(() => {
    addCorrection(db, { type: 'policy', content: 'Policy 1', permanence: 'never' });
    addCorrection(db, { type: 'fact', content: 'Fact 1', permanence: 'never' });
    addCorrection(db, { type: 'pattern', content: 'Pattern 1', permanence: 'graduable' });
  });

  it('lists all corrections', () => {
    const all = listCorrections(db);
    expect(all).toHaveLength(3);
  });

  it('filters by type', () => {
    const policies = listCorrections(db, { type: 'policy' });
    expect(policies).toHaveLength(1);
    expect(policies[0].content).toBe('Policy 1');
  });

  it('filters active only', () => {
    const all = listCorrections(db);
    const id = all.find(c => c.type === 'pattern')!.id;
    graduateCorrection(db, id);

    const active = listCorrections(db, { active: true });
    expect(active).toHaveLength(2);
  });
});

describe('recordViolation', () => {
  it('increments violation count and resets streak', () => {
    const id = addCorrection(db, { type: 'pattern', content: 'Test' });

    recordViolation(db, id);
    let c = getCorrection(db, id)!;
    expect(c.violation_count).toBe(1);
    expect(c.streak_days).toBe(0);
    expect(c.last_violated).toBeTruthy();

    recordViolation(db, id);
    c = getCorrection(db, id)!;
    expect(c.violation_count).toBe(2);
  });
});

describe('graduateCorrection', () => {
  it('graduates a graduable correction', () => {
    const id = addCorrection(db, { type: 'pattern', content: 'Test', permanence: 'graduable' });
    graduateCorrection(db, id);
    const c = getCorrection(db, id)!;
    expect(c.graduated_at).toBeTruthy();
  });

  it('does not graduate a permanent correction', () => {
    const id = addCorrection(db, { type: 'policy', content: 'Test', permanence: 'never' });
    graduateCorrection(db, id);
    const c = getCorrection(db, id)!;
    expect(c.graduated_at).toBeNull();
  });
});

describe('deleteCorrection', () => {
  it('removes the correction', () => {
    const id = addCorrection(db, { type: 'fact', content: 'Test' });
    deleteCorrection(db, id);
    expect(getCorrection(db, id)).toBeUndefined();
  });
});

describe('getContext', () => {
  beforeEach(() => {
    addCorrection(db, { type: 'policy', content: 'No work stuff', permanence: 'never' });
    addCorrection(db, { type: 'fact', content: 'Kim earns $105/hr', permanence: 'never' });
    addCorrection(db, { type: 'pattern', content: 'Check dates', permanence: 'graduable' });
    addCorrection(db, { type: 'technical', content: 'No MCP in cron', permanence: 'graduable' });
  });

  it('returns markdown with all types in priority order', () => {
    const ctx = getContext(db);
    const policyIdx = ctx.indexOf('## Policy');
    const factIdx = ctx.indexOf('## Fact');
    const patternIdx = ctx.indexOf('## Pattern');
    const techIdx = ctx.indexOf('## Technical');
    expect(policyIdx).toBeLessThan(factIdx);
    expect(factIdx).toBeLessThan(patternIdx);
    expect(patternIdx).toBeLessThan(techIdx);
  });

  it('respects budget', () => {
    const ctx = getContext(db, 100);
    expect(ctx.length).toBeLessThanOrEqual(100);
  });

  it('excludes graduated corrections', () => {
    const all = listCorrections(db);
    const pattern = all.find(c => c.type === 'pattern')!;
    graduateCorrection(db, pattern.id);

    const ctx = getContext(db);
    expect(ctx).not.toContain('Check dates');
  });

  it('shows violations first within type', () => {
    const id = addCorrection(db, { type: 'pattern', content: 'Violated pattern', permanence: 'graduable' });
    recordViolation(db, id);

    const ctx = getContext(db);
    const violatedIdx = ctx.indexOf('Violated pattern');
    const checkIdx = ctx.indexOf('Check dates');
    expect(violatedIdx).toBeLessThan(checkIdx);
  });
});

describe('getStats', () => {
  it('returns correct counts', () => {
    addCorrection(db, { type: 'policy', content: 'P1', permanence: 'never' });
    addCorrection(db, { type: 'fact', content: 'F1', permanence: 'never' });
    addCorrection(db, { type: 'pattern', content: 'Pa1', permanence: 'graduable' });

    const id = addCorrection(db, { type: 'pattern', content: 'Pa2', permanence: 'graduable' });
    recordViolation(db, id);
    recordViolation(db, id);
    graduateCorrection(db, id);

    const s = getStats(db);
    expect(s.total).toBe(4);
    expect(s.active).toBe(3);
    expect(s.graduated).toBe(1);
    expect(s.by_type.policy).toBe(1);
    expect(s.by_type.fact).toBe(1);
    expect(s.by_type.pattern).toBe(1); // only active
    expect(s.by_permanence.never).toBe(2);
    expect(s.by_permanence.graduable).toBe(1); // only active
    expect(s.total_violations).toBe(2);
  });

  it('returns zeros for empty db', () => {
    const s = getStats(db);
    expect(s.total).toBe(0);
    expect(s.active).toBe(0);
    expect(s.total_violations).toBe(0);
  });
});

describe('resolveId', () => {
  it('resolves exact full UUID', () => {
    const id = addCorrection(db, { type: 'fact', content: 'Test' });
    expect(resolveId(db, 'corrections', id)).toBe(id);
  });

  it('resolves 8-char prefix to full UUID', () => {
    const id = addCorrection(db, { type: 'fact', content: 'Test' });
    const prefix = id.slice(0, 8);
    expect(resolveId(db, 'corrections', prefix)).toBe(id);
  });

  it('returns undefined for non-existent ID', () => {
    expect(resolveId(db, 'corrections', 'nonexistent')).toBeUndefined();
  });

  it('returns undefined for ambiguous prefix', () => {
    // Insert two corrections with manually crafted IDs sharing a prefix
    db.prepare(`INSERT INTO corrections (id, type, content) VALUES (?, 'fact', 'A')`).run('aaaaaaaa-1111-2222-3333-444444444444');
    db.prepare(`INSERT INTO corrections (id, type, content) VALUES (?, 'fact', 'B')`).run('aaaaaaaa-5555-6666-7777-888888888888');
    // 8-char prefix 'aaaaaaaa' matches both — should return undefined
    expect(resolveId(db, 'corrections', 'aaaaaaaa')).toBeUndefined();
  });

  it('prefix-matches truncated IDs even with hyphens', () => {
    const id = addCorrection(db, { type: 'fact', content: 'Test' });
    // A partial UUID with hyphens should still prefix-match if unique
    const partial = id.slice(0, 13); // e.g. 'xxxxxxxx-xxxx'
    expect(resolveId(db, 'corrections', partial)).toBe(id);
  });

  it('prefix-matches custom non-UUID IDs with hyphens', () => {
    // Simulate the ghost prediction bug: non-UUID IDs with hyphens
    db.prepare(`INSERT INTO corrections (id, type, content) VALUES (?, 'fact', 'Custom')`).run('waiver-1776223725445');
    expect(resolveId(db, 'corrections', 'waiver-1')).toBe('waiver-1776223725445');
  });

  it('does not prefix-match full-length UUIDs', () => {
    // A 36-char string that doesn't match should return undefined, not prefix-search
    expect(resolveId(db, 'corrections', 'zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz')).toBeUndefined();
  });

  it('works with getCorrection for prefix lookup', () => {
    const id = addCorrection(db, { type: 'pattern', content: 'Prefix test' });
    const prefix = id.slice(0, 8);
    const c = getCorrection(db, prefix);
    expect(c).toBeDefined();
    expect(c!.id).toBe(id);
    expect(c!.content).toBe('Prefix test');
  });

  it('works with recordViolation using prefix', () => {
    const id = addCorrection(db, { type: 'pattern', content: 'Violation prefix test' });
    const prefix = id.slice(0, 8);
    recordViolation(db, prefix);
    const c = getCorrection(db, id)!;
    expect(c.violation_count).toBe(1);
  });

  it('works with graduateCorrection using prefix', () => {
    const id = addCorrection(db, { type: 'pattern', content: 'Graduate prefix test', permanence: 'graduable' });
    const prefix = id.slice(0, 8);
    graduateCorrection(db, prefix);
    const c = getCorrection(db, id)!;
    expect(c.graduated_at).toBeTruthy();
  });

  it('works with deleteCorrection using prefix', () => {
    const id = addCorrection(db, { type: 'fact', content: 'Delete prefix test' });
    const prefix = id.slice(0, 8);
    deleteCorrection(db, prefix);
    expect(getCorrection(db, id)).toBeUndefined();
  });
});

describe('searchCorrections', () => {
  beforeEach(() => {
    addCorrection(db, { type: 'policy', content: 'Brain is personal only', permanence: 'never' });
    addCorrection(db, { type: 'fact', content: 'Kim earns $105 per hour', permanence: 'never' });
    addCorrection(db, { type: 'pattern', content: 'Always verify dates and days of week', permanence: 'graduable' });
    addCorrection(db, { type: 'technical', content: 'No MCP tools in cron jobs', permanence: 'graduable' });
  });

  it('finds corrections matching query', () => {
    const results = searchCorrections(db, 'Kim');
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('Kim');
  });

  it('returns empty for no matches', () => {
    const results = searchCorrections(db, 'nonexistent term xyz');
    expect(results).toHaveLength(0);
  });

  it('filters by type', () => {
    const results = searchCorrections(db, 'verify', { type: 'pattern' });
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('pattern');
  });

  it('respects limit', () => {
    const results = searchCorrections(db, 'a', { limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('excludes graduated corrections', () => {
    const id = addCorrection(db, { type: 'pattern', content: 'Graduated searchable content', permanence: 'graduable' });
    graduateCorrection(db, id);
    const results = searchCorrections(db, 'Graduated searchable');
    expect(results).toHaveLength(0);
  });

  it('orders by violation count descending', () => {
    const high = addCorrection(db, { type: 'fact', content: 'High violation searchable', permanence: 'never' });
    const low = addCorrection(db, { type: 'fact', content: 'Low violation searchable', permanence: 'never' });
    recordViolation(db, high);
    recordViolation(db, high);
    recordViolation(db, high);
    recordViolation(db, low);

    const results = searchCorrections(db, 'searchable');
    expect(results).toHaveLength(2);
    expect(results[0].violation_count).toBe(3);
    expect(results[1].violation_count).toBe(1);
  });
});

describe('listCorrections with limit', () => {
  it('defaults to 100 limit', () => {
    // Add 3 corrections, should all be returned
    addCorrection(db, { type: 'fact', content: 'F1' });
    addCorrection(db, { type: 'fact', content: 'F2' });
    addCorrection(db, { type: 'fact', content: 'F3' });
    const results = listCorrections(db);
    expect(results).toHaveLength(3);
  });

  it('respects explicit limit', () => {
    addCorrection(db, { type: 'fact', content: 'F1' });
    addCorrection(db, { type: 'fact', content: 'F2' });
    addCorrection(db, { type: 'fact', content: 'F3' });
    const results = listCorrections(db, { limit: 2 });
    expect(results).toHaveLength(2);
  });
});

describe('runMigration', () => {
  it('runs a migration once', () => {
    const ran = runMigration(db, 'test_migration', `CREATE TABLE test_mig (id TEXT PRIMARY KEY)`);
    expect(ran).toBe(true);

    // Table should exist
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='test_mig'").all();
    expect(tables).toHaveLength(1);
  });

  it('does not run the same migration twice', () => {
    runMigration(db, 'test_once', `CREATE TABLE test_once (id TEXT PRIMARY KEY)`);
    const ran = runMigration(db, 'test_once', `CREATE TABLE test_once_again (id TEXT PRIMARY KEY)`);
    expect(ran).toBe(false);

    // Second table should NOT exist
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='test_once_again'").all();
    expect(tables).toHaveLength(0);
  });

  it('handles duplicate column errors gracefully', () => {
    // The corrections table already has 'content' column
    const ran = runMigration(db, 'add_content_again', `ALTER TABLE corrections ADD COLUMN content TEXT`);
    expect(ran).toBe(false);
  });
});
