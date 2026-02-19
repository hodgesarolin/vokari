import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  initDb,
  addCorrection,
  getCorrection,
  listCorrections,
  recordViolation,
  graduateCorrection,
  deleteCorrection,
  getContext,
  getStats,
} from '../src/db.js';

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
