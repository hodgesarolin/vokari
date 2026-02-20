import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from '../src/db.js';
import { addBelief, initBeliefs, confirmBelief, recordContradiction, getBelief } from '../src/beliefs.js';
import {
  initVerifications,
  createVerification,
  getVerification,
  verificationTick,
  recordVerification,
  skipVerification,
  getBeliefVerifications,
  verificationStatus,
} from '../src/verification.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  // Init tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS corrections (
      id TEXT PRIMARY KEY, type TEXT, content TEXT, root_cause TEXT,
      example_bad TEXT, example_good TEXT, permanence TEXT DEFAULT 'conditional',
      created_at TEXT DEFAULT (datetime('now')), last_violated TEXT,
      violation_count INTEGER DEFAULT 0, streak_days INTEGER DEFAULT 0,
      graduation_eligible TEXT, graduated_at TEXT, source TEXT
    );
    CREATE TABLE IF NOT EXISTS predictions (
      id TEXT PRIMARY KEY, topic TEXT, prediction TEXT, confidence REAL,
      reasoning TEXT, resolution_criteria TEXT, check_date TEXT,
      domain TEXT DEFAULT 'general', outcome TEXT, outcome_notes TEXT,
      resolved_at TEXT, created_at TEXT DEFAULT (datetime('now')), supersedes TEXT
    );
    CREATE TABLE IF NOT EXISTS positions (
      id TEXT PRIMARY KEY, topic TEXT, position TEXT, reasoning TEXT,
      evidence TEXT, confidence REAL, status TEXT DEFAULT 'held',
      created_at TEXT DEFAULT (datetime('now')), last_challenged TEXT,
      challenge_count INTEGER DEFAULT 0, revision_history TEXT,
      supersedes TEXT, counterevidence TEXT
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT, session_id TEXT,
      data TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  initBeliefs(db);
  initVerifications(db);
});

afterEach(() => {
  db.close();
});

// ── Helpers ──

function addTestBelief(statement: string, opts?: {
  confidence?: number;
  category?: string;
  lastConfirmed?: string | null;
}): string {
  const id = addBelief(db, {
    statement,
    confidence: opts?.confidence ?? 0.8,
    category: (opts?.category ?? 'world') as 'world' | 'user' | 'system' | 'self',
  });
  if (opts?.lastConfirmed !== undefined) {
    db.prepare('UPDATE beliefs SET last_confirmed = ? WHERE id = ?')
      .run(opts.lastConfirmed, id);
  }
  return id;
}

// ── Schema ──

describe('initVerifications', () => {
  it('creates the verifications table', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='verifications'"
    ).all();
    expect(tables).toHaveLength(1);
  });

  it('is idempotent', () => {
    initVerifications(db);
    initVerifications(db);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='verifications'"
    ).all();
    expect(tables).toHaveLength(1);
  });
});

// ── createVerification ──

describe('createVerification', () => {
  it('creates a pending verification for a belief', () => {
    const beliefId = addTestBelief('test belief');
    const vId = createVerification(db, beliefId);
    const v = getVerification(db, vId);
    expect(v).toBeDefined();
    expect(v!.belief_id).toBe(beliefId);
    expect(v!.status).toBe('pending');
    expect(v!.strategy).toBe('manual');
    expect(v!.outcome).toBeNull();
  });

  it('uses provided strategy', () => {
    const beliefId = addTestBelief('test belief');
    const vId = createVerification(db, beliefId, 'staleness');
    const v = getVerification(db, vId);
    expect(v!.strategy).toBe('staleness');
  });

  it('returns existing ID if pending verification already exists', () => {
    const beliefId = addTestBelief('test belief');
    const id1 = createVerification(db, beliefId);
    const id2 = createVerification(db, beliefId);
    expect(id1).toBe(id2);
  });

  it('returns existing ID if in_progress verification exists', () => {
    const beliefId = addTestBelief('test belief');
    const id1 = createVerification(db, beliefId);
    // Simulate tick claiming it
    db.prepare("UPDATE verifications SET status = 'in_progress' WHERE id = ?").run(id1);
    const id2 = createVerification(db, beliefId);
    expect(id1).toBe(id2);
  });

  it('allows new verification if previous is completed', () => {
    const beliefId = addTestBelief('test belief');
    const id1 = createVerification(db, beliefId);
    db.prepare("UPDATE verifications SET status = 'completed', outcome = 'confirmed' WHERE id = ?").run(id1);
    const id2 = createVerification(db, beliefId);
    expect(id2).not.toBe(id1);
  });
});

// ── getVerification ──

describe('getVerification', () => {
  it('returns undefined for missing ID', () => {
    expect(getVerification(db, 'nonexistent')).toBeUndefined();
  });

  it('parses JSON evidence field', () => {
    const beliefId = addTestBelief('test belief');
    const vId = createVerification(db, beliefId);
    const v = getVerification(db, vId);
    expect(Array.isArray(v!.evidence)).toBe(true);
    expect(v!.evidence).toEqual([]);
  });
});

// ── verificationTick ──

describe('verificationTick', () => {
  it('returns empty when no beliefs exist', () => {
    const result = verificationTick(db);
    expect(result.items).toHaveLength(0);
    expect(result.skipped).toBe(0);
    expect(result.total_pending).toBe(0);
  });

  it('claims manually queued pending verifications first', () => {
    const beliefId = addTestBelief('manual check belief');
    const vId = createVerification(db, beliefId, 'manual');
    const result = verificationTick(db);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].verification_id).toBe(vId);
    expect(result.items[0].belief_statement).toBe('manual check belief');
    // Should now be in_progress
    const v = getVerification(db, vId);
    expect(v!.status).toBe('in_progress');
  });

  it('auto-selects never-verified beliefs', () => {
    addTestBelief('never verified 1');
    addTestBelief('never verified 2');
    const result = verificationTick(db, 5);
    expect(result.items.length).toBeGreaterThanOrEqual(2);
    expect(result.items.every(i => i.strategy === 'never_verified')).toBe(true);
  });

  it('respects budget limit', () => {
    addTestBelief('belief 1');
    addTestBelief('belief 2');
    addTestBelief('belief 3');
    addTestBelief('belief 4');
    addTestBelief('belief 5');
    const result = verificationTick(db, 2);
    expect(result.items).toHaveLength(2);
  });

  it('prioritizes challenged beliefs over active', () => {
    const activeId = addTestBelief('active belief', { lastConfirmed: '2026-01-01' });
    const challengedId = addTestBelief('challenged belief', { lastConfirmed: '2026-01-01' });
    // Make one challenged
    recordContradiction(db, challengedId, 'observation 1');
    recordContradiction(db, challengedId, 'observation 2');
    const belief = getBelief(db, challengedId);
    expect(belief!.status).toBe('challenged');

    const result = verificationTick(db, 1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].belief_id).toBe(challengedId);
    expect(result.items[0].strategy).toBe('challenged');
  });

  it('skips beliefs verified within cooldown window', () => {
    const beliefId = addTestBelief('recently verified');
    // Create a completed verification
    const vId = createVerification(db, beliefId);
    db.prepare(`
      UPDATE verifications
      SET status = 'completed', outcome = 'confirmed', completed_at = datetime('now')
      WHERE id = ?
    `).run(vId);

    const result = verificationTick(db, 5, 24);
    const ids = result.items.map(i => i.belief_id);
    expect(ids).not.toContain(beliefId);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });

  it('does not return retired beliefs', () => {
    const id = addTestBelief('will be retired');
    db.prepare("UPDATE beliefs SET status = 'retired' WHERE id = ?").run(id);
    const result = verificationTick(db, 5);
    const ids = result.items.map(i => i.belief_id);
    expect(ids).not.toContain(id);
  });

  it('does not double-claim in-progress items', () => {
    addTestBelief('belief A');
    // First tick claims it
    const r1 = verificationTick(db, 5);
    expect(r1.items).toHaveLength(1);
    // Second tick should not return the same belief
    const r2 = verificationTick(db, 5);
    expect(r2.items).toHaveLength(0);
  });

  it('assigns high_confidence strategy for 90%+ beliefs', () => {
    addTestBelief('very confident belief', { confidence: 0.95, lastConfirmed: '2026-01-01' });
    const result = verificationTick(db, 1);
    expect(result.items[0].strategy).toBe('high_confidence');
  });

  it('assigns contradiction strategy for beliefs with contradictions', () => {
    const id = addTestBelief('has contradiction', { lastConfirmed: '2026-01-01' });
    recordContradiction(db, id, 'counter evidence');
    // Only 1 contradiction, so still active (needs 2 to auto-challenge)
    const result = verificationTick(db, 1);
    expect(result.items[0].strategy).toBe('contradiction');
  });

  it('assigns staleness strategy for old confirmed beliefs', () => {
    addTestBelief('old belief', { confidence: 0.7, lastConfirmed: '2025-06-01' });
    const result = verificationTick(db, 1);
    expect(result.items[0].strategy).toBe('staleness');
  });

  it('handles mixed pending + auto-select', () => {
    const manualId = addTestBelief('manual');
    createVerification(db, manualId, 'manual');
    addTestBelief('auto 1');
    addTestBelief('auto 2');
    const result = verificationTick(db, 3);
    expect(result.items).toHaveLength(3);
    expect(result.items[0].strategy).toBe('manual');
  });
});

// ── recordVerification ──

describe('recordVerification', () => {
  it('completes a verification with outcome', () => {
    const beliefId = addTestBelief('test belief');
    const vId = createVerification(db, beliefId);
    verificationTick(db); // claim it
    const result = recordVerification(db, vId, 'confirmed', ['evidence 1']);
    expect(result).toBeDefined();
    expect(result!.status).toBe('completed');
    expect(result!.outcome).toBe('confirmed');
    expect(result!.evidence).toEqual(['evidence 1']);
    expect(result!.completed_at).not.toBeNull();
  });

  it('returns undefined for missing verification', () => {
    expect(recordVerification(db, 'nonexistent', 'confirmed')).toBeUndefined();
  });

  it('updates belief last_confirmed when outcome is confirmed', () => {
    const beliefId = addTestBelief('verify me');
    const vId = createVerification(db, beliefId);
    verificationTick(db);
    recordVerification(db, vId, 'confirmed', ['looks good']);
    const belief = getBelief(db, beliefId);
    expect(belief!.last_confirmed).not.toBeNull();
  });

  it('does not update belief last_confirmed for non-confirmed outcomes', () => {
    const beliefId = addTestBelief('verify me', { lastConfirmed: null });
    const vId = createVerification(db, beliefId);
    verificationTick(db);
    recordVerification(db, vId, 'contradicted', ['found counter-evidence']);
    const belief = getBelief(db, beliefId);
    // last_confirmed should still be null (contradicted doesn't confirm)
    expect(belief!.last_confirmed).toBeNull();
  });

  it('stores notes', () => {
    const beliefId = addTestBelief('test');
    const vId = createVerification(db, beliefId);
    verificationTick(db);
    const result = recordVerification(db, vId, 'inconclusive', [], 'not enough data');
    expect(result!.notes).toBe('not enough data');
  });

  it('stores multiple evidence items', () => {
    const beliefId = addTestBelief('test');
    const vId = createVerification(db, beliefId);
    verificationTick(db);
    const result = recordVerification(db, vId, 'revised', ['source A', 'source B', 'source C']);
    expect(result!.evidence).toEqual(['source A', 'source B', 'source C']);
  });
});

// ── skipVerification ──

describe('skipVerification', () => {
  it('marks verification as skipped', () => {
    const beliefId = addTestBelief('test');
    const vId = createVerification(db, beliefId);
    skipVerification(db, vId, 'belief retired');
    const v = getVerification(db, vId);
    expect(v!.status).toBe('skipped');
    expect(v!.notes).toBe('belief retired');
  });

  it('sets completed_at', () => {
    const beliefId = addTestBelief('test');
    const vId = createVerification(db, beliefId);
    skipVerification(db, vId);
    const v = getVerification(db, vId);
    expect(v!.completed_at).not.toBeNull();
  });
});

// ── getBeliefVerifications ──

describe('getBeliefVerifications', () => {
  it('returns empty for belief with no verifications', () => {
    const beliefId = addTestBelief('test');
    expect(getBeliefVerifications(db, beliefId)).toHaveLength(0);
  });

  it('returns all verifications for a belief', () => {
    const beliefId = addTestBelief('test');
    const v1 = createVerification(db, beliefId);
    db.prepare("UPDATE verifications SET status = 'completed', outcome = 'confirmed', created_at = datetime('now', '-1 hour') WHERE id = ?").run(v1);
    const v2 = createVerification(db, beliefId);

    const history = getBeliefVerifications(db, beliefId);
    expect(history).toHaveLength(2);
    // Most recent first
    expect(history[0].id).toBe(v2);
    expect(history[1].id).toBe(v1);
  });

  it('does not return verifications for other beliefs', () => {
    const b1 = addTestBelief('belief 1');
    const b2 = addTestBelief('belief 2');
    createVerification(db, b1);
    createVerification(db, b2);

    const history = getBeliefVerifications(db, b1);
    expect(history).toHaveLength(1);
    expect(history[0].belief_id).toBe(b1);
  });
});

// ── verificationStatus ──

describe('verificationStatus', () => {
  it('returns zeroes when empty', () => {
    const stats = verificationStatus(db);
    expect(stats.total).toBe(0);
    expect(stats.by_status.pending).toBe(0);
    expect(stats.by_status.completed).toBe(0);
    expect(stats.beliefs_verified).toBe(0);
  });

  it('counts beliefs never verified', () => {
    addTestBelief('a');
    addTestBelief('b');
    addTestBelief('c');
    const stats = verificationStatus(db);
    expect(stats.beliefs_never_verified).toBe(3);
  });

  it('tracks status breakdown', () => {
    const b1 = addTestBelief('b1');
    const b2 = addTestBelief('b2');
    const v1 = createVerification(db, b1);
    createVerification(db, b2);
    // Complete one
    db.prepare("UPDATE verifications SET status = 'completed', outcome = 'confirmed' WHERE id = ?").run(v1);

    const stats = verificationStatus(db);
    expect(stats.total).toBe(2);
    expect(stats.by_status.completed).toBe(1);
    expect(stats.by_status.pending).toBe(1);
  });

  it('tracks outcome breakdown', () => {
    const b1 = addTestBelief('b1');
    const b2 = addTestBelief('b2');
    const b3 = addTestBelief('b3');
    const v1 = createVerification(db, b1);
    const v2 = createVerification(db, b2);
    const v3 = createVerification(db, b3);
    db.prepare("UPDATE verifications SET status = 'completed', outcome = 'confirmed' WHERE id = ?").run(v1);
    db.prepare("UPDATE verifications SET status = 'completed', outcome = 'contradicted' WHERE id = ?").run(v2);
    db.prepare("UPDATE verifications SET status = 'completed', outcome = 'revised' WHERE id = ?").run(v3);

    const stats = verificationStatus(db);
    expect(stats.by_outcome.confirmed).toBe(1);
    expect(stats.by_outcome.contradicted).toBe(1);
    expect(stats.by_outcome.revised).toBe(1);
  });

  it('tracks strategy breakdown', () => {
    const b1 = addTestBelief('b1');
    const b2 = addTestBelief('b2');
    createVerification(db, b1, 'manual');
    createVerification(db, b2, 'staleness');

    const stats = verificationStatus(db);
    expect(stats.by_strategy.manual).toBe(1);
    expect(stats.by_strategy.staleness).toBe(1);
  });

  it('counts verified vs unverified beliefs', () => {
    const b1 = addTestBelief('verified');
    addTestBelief('not verified');
    const v1 = createVerification(db, b1);
    db.prepare("UPDATE verifications SET status = 'completed', outcome = 'confirmed' WHERE id = ?").run(v1);

    const stats = verificationStatus(db);
    expect(stats.beliefs_verified).toBe(1);
    expect(stats.beliefs_never_verified).toBe(1);
  });
});

// ── Integration: full tick → verify → tick cycle ──

describe('full verification cycle', () => {
  it('tick → review → record → tick skips on cooldown', () => {
    const beliefId = addTestBelief('Earth is round', { confidence: 0.95 });

    // Tick 1: picks up the belief
    const r1 = verificationTick(db, 1);
    expect(r1.items).toHaveLength(1);
    const vId = r1.items[0].verification_id;

    // Record result
    recordVerification(db, vId, 'confirmed', ['observable from space']);

    // Tick 2: should skip (within cooldown)
    const r2 = verificationTick(db, 5, 24);
    const ids = r2.items.map(i => i.belief_id);
    expect(ids).not.toContain(beliefId);
  });

  it('tick → review → record → tick picks up after cooldown expires', () => {
    const beliefId = addTestBelief('test belief');

    // Tick 1
    const r1 = verificationTick(db, 1);
    const vId = r1.items[0].verification_id;
    recordVerification(db, vId, 'confirmed');

    // Manually backdate the completion to simulate cooldown expiry
    db.prepare(`
      UPDATE verifications SET completed_at = datetime('now', '-48 hours') WHERE id = ?
    `).run(vId);

    // Tick 2 with 24h cooldown: should pick it up again
    const r2 = verificationTick(db, 5, 24);
    const ids = r2.items.map(i => i.belief_id);
    expect(ids).toContain(beliefId);
  });

  it('multiple hosts share verification state', () => {
    const b1 = addTestBelief('belief 1');
    const b2 = addTestBelief('belief 2');
    const b3 = addTestBelief('belief 3');

    // Host A takes 1 item
    const hostA = verificationTick(db, 1);
    expect(hostA.items).toHaveLength(1);

    // Host B takes 1 item — should NOT get the same belief
    const hostB = verificationTick(db, 1);
    expect(hostB.items).toHaveLength(1);
    expect(hostB.items[0].belief_id).not.toBe(hostA.items[0].belief_id);

    // Host C takes 1 item — gets the third belief
    const hostC = verificationTick(db, 1);
    expect(hostC.items).toHaveLength(1);
    const allIds = [hostA.items[0].belief_id, hostB.items[0].belief_id, hostC.items[0].belief_id];
    expect(new Set(allIds).size).toBe(3); // All unique

    // Host D: nothing left
    const hostD = verificationTick(db, 1);
    expect(hostD.items).toHaveLength(0);
  });

  it('skip does not block future verifications', () => {
    const beliefId = addTestBelief('skippable');
    const r1 = verificationTick(db, 1);
    skipVerification(db, r1.items[0].verification_id, 'not enough info');

    // Should be pickable again (skipped verifications have completed_at set,
    // but they should still show up after cooldown)
    db.prepare(`
      UPDATE verifications SET completed_at = datetime('now', '-48 hours') WHERE belief_id = ?
    `).run(beliefId);

    const r2 = verificationTick(db, 5, 24);
    const ids = r2.items.map(i => i.belief_id);
    expect(ids).toContain(beliefId);
  });
});
