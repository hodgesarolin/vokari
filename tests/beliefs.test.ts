import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  initBeliefs,
  addBelief,
  getBelief,
  listBeliefs,
  checkObservation,
  recordContradiction,
  confirmBelief,
  reviseBelief,
  retireBelief,
  getBeliefContext,
  getBeliefStats,
  containsNegation,
  hasConflictingNumericValues,
  parseApproxNumber,
  SENSITIVITY_THRESHOLDS,
} from '../src/beliefs.js';
import type { BeliefSensitivity } from '../src/beliefs.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  initBeliefs(db);
});

describe('initBeliefs', () => {
  it('creates the beliefs table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='beliefs'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('is idempotent', () => {
    initBeliefs(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='beliefs'")
      .all();
    expect(tables).toHaveLength(1);
  });
});

describe('addBelief', () => {
  it('returns a UUID', () => {
    const id = addBelief(db, { statement: 'The sky is blue' });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('stores all fields', () => {
    const id = addBelief(db, {
      statement: 'Kim prefers dark mode',
      category: 'user',
      confidence: 0.9,
      source: 'direct statement',
      evidence: ['said so in chat'],
      tags: ['preferences', 'ui'],
    });
    const b = getBelief(db, id);
    expect(b).toBeDefined();
    expect(b!.statement).toBe('Kim prefers dark mode');
    expect(b!.category).toBe('user');
    expect(b!.confidence).toBe(0.9);
    expect(b!.source).toBe('direct statement');
    expect(b!.evidence).toEqual(['said so in chat']);
    expect(b!.tags).toEqual(['preferences', 'ui']);
    expect(b!.status).toBe('active');
    expect(b!.contradictions).toEqual([]);
    expect(b!.revision_history).toEqual([]);
  });

  it('defaults category to world', () => {
    const id = addBelief(db, { statement: 'Test' });
    expect(getBelief(db, id)!.category).toBe('world');
  });

  it('defaults confidence to 0.7', () => {
    const id = addBelief(db, { statement: 'Test' });
    expect(getBelief(db, id)!.confidence).toBeCloseTo(0.7);
  });

  it('defaults source to observation', () => {
    const id = addBelief(db, { statement: 'Test' });
    expect(getBelief(db, id)!.source).toBe('observation');
  });

  it('clamps confidence to [0, 1]', () => {
    const high = addBelief(db, { statement: 'Too high', confidence: 1.5 });
    expect(getBelief(db, high)!.confidence).toBe(1);

    const low = addBelief(db, { statement: 'Too low', confidence: -0.3 });
    expect(getBelief(db, low)!.confidence).toBe(0);
  });

  it('defaults sensitivity to approximate', () => {
    const id = addBelief(db, { statement: 'Test' });
    expect(getBelief(db, id)!.sensitivity).toBe('approximate');
  });

  it('stores custom sensitivity', () => {
    const id = addBelief(db, { statement: 'Kim earns $105/hr', sensitivity: 'personal' });
    expect(getBelief(db, id)!.sensitivity).toBe('personal');
  });

  it('stores institutional sensitivity', () => {
    const id = addBelief(db, { statement: 'PS 28 has 918 students', sensitivity: 'institutional' });
    expect(getBelief(db, id)!.sensitivity).toBe('institutional');
  });
});

describe('getBelief', () => {
  it('returns undefined for nonexistent id', () => {
    expect(getBelief(db, 'nonexistent')).toBeUndefined();
  });

  it('parses JSON fields correctly', () => {
    const id = addBelief(db, {
      statement: 'Test',
      evidence: ['a', 'b'],
      tags: ['tag1'],
    });
    const b = getBelief(db, id)!;
    expect(Array.isArray(b.evidence)).toBe(true);
    expect(Array.isArray(b.tags)).toBe(true);
    expect(Array.isArray(b.contradictions)).toBe(true);
    expect(Array.isArray(b.revision_history)).toBe(true);
  });
});

describe('listBeliefs', () => {
  beforeEach(() => {
    addBelief(db, { statement: 'User pref', category: 'user', tags: ['prefs'] });
    addBelief(db, { statement: 'World fact', category: 'world', tags: ['facts'] });
    addBelief(db, { statement: 'System thing', category: 'system', tags: ['prefs'] });
  });

  it('lists all beliefs when no filters', () => {
    expect(listBeliefs(db)).toHaveLength(3);
  });

  it('filters by category', () => {
    const userBeliefs = listBeliefs(db, { category: 'user' });
    expect(userBeliefs).toHaveLength(1);
    expect(userBeliefs[0].statement).toBe('User pref');
  });

  it('filters by status', () => {
    const all = listBeliefs(db);
    const id = all[0].id;
    retireBelief(db, id, 'no longer relevant');
    const active = listBeliefs(db, { status: 'active' });
    expect(active).toHaveLength(2);
  });

  it('filters by tags', () => {
    const prefsBeliefs = listBeliefs(db, { tags: ['prefs'] });
    expect(prefsBeliefs).toHaveLength(2);
  });

  it('filters by challengedOnly', () => {
    const all = listBeliefs(db);
    // challenge a belief by adding 2 contradictions
    recordContradiction(db, all[0].id, 'obs1', 'reason1');
    recordContradiction(db, all[0].id, 'obs2', 'reason2');

    const challenged = listBeliefs(db, { challengedOnly: true });
    expect(challenged).toHaveLength(1);
  });

  it('returns beliefs in descending first_recorded order', () => {
    const beliefs = listBeliefs(db);
    // Most recent first
    expect(beliefs.length).toBe(3);
  });
});

describe('checkObservation', () => {
  it('returns matches with relevance scores', () => {
    addBelief(db, { statement: 'Kim prefers using typescript for projects' });
    const result = checkObservation(db, 'Kim prefers using javascript for projects');
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0].relevance).toBeGreaterThanOrEqual(0.2);
  });

  it('detects negation contradictions', () => {
    addBelief(db, { statement: 'Kim prefers using typescript for projects' });
    const result = checkObservation(db, 'Kim does not prefer using typescript for projects');
    expect(result.contradictions.length).toBeGreaterThan(0);
    expect(result.contradictions[0].reason).toBe('negation_detected');
  });

  it('detects numeric conflicts', () => {
    addBelief(db, { statement: 'Server costs about $500 monthly' });
    const result = checkObservation(db, 'Server costs about $800 monthly');
    expect(result.contradictions.length).toBeGreaterThan(0);
    expect(result.contradictions[0].reason).toBe('conflicting_values');
  });

  it('uses belief sensitivity for numeric contradiction threshold', () => {
    // $105 vs $96 = 9.4% — should be caught with personal sensitivity
    addBelief(db, { statement: 'Kim hourly income rate about $96', sensitivity: 'personal' });
    const result = checkObservation(db, 'Kim hourly income rate about $105');
    expect(result.contradictions.length).toBeGreaterThan(0);
    expect(result.contradictions[0].reason).toBe('conflicting_values');
  });

  it('does not flag small differences at approximate sensitivity', () => {
    // Same values but with approximate (default) sensitivity — should NOT be caught
    addBelief(db, { statement: 'Server costs about $96 monthly' });
    const result = checkObservation(db, 'Server costs about $105 monthly');
    expect(result.contradictions).toHaveLength(0);
  });

  it('filters by category', () => {
    addBelief(db, { statement: 'Kim prefers dark mode', category: 'user' });
    addBelief(db, { statement: 'Kim prefers light mode', category: 'system' });
    const result = checkObservation(db, 'Kim does not prefer dark mode interface', 'user');
    // Should only match user beliefs
    for (const m of result.matches) {
      expect(m.belief.category).toBe('user');
    }
  });

  it('returns empty results when no matches', () => {
    addBelief(db, { statement: 'The sky is blue' });
    const result = checkObservation(db, 'Cats enjoy sleeping');
    expect(result.matches).toHaveLength(0);
    expect(result.contradictions).toHaveLength(0);
  });

  it('sorts matches by relevance descending', () => {
    addBelief(db, { statement: 'Kim prefers typescript for all backend projects' });
    addBelief(db, { statement: 'Kim prefers something else entirely different' });
    const result = checkObservation(db, 'Kim prefers typescript for frontend projects');
    if (result.matches.length > 1) {
      expect(result.matches[0].relevance).toBeGreaterThanOrEqual(result.matches[1].relevance);
    }
  });
});

describe('recordContradiction', () => {
  it('adds a contradiction entry', () => {
    const id = addBelief(db, { statement: 'Test belief' });
    const updated = recordContradiction(db, id, 'contradicting observation', 'test reason');
    expect(updated).toBeDefined();
    expect(updated!.contradictions).toHaveLength(1);
    expect(updated!.contradictions[0].observation).toBe('contradicting observation');
    expect(updated!.contradictions[0].reason).toBe('test reason');
  });

  it('defaults reason to manual', () => {
    const id = addBelief(db, { statement: 'Test belief' });
    const updated = recordContradiction(db, id, 'observation');
    expect(updated!.contradictions[0].reason).toBe('manual');
  });

  it('auto-challenges at 2+ contradictions', () => {
    const id = addBelief(db, { statement: 'Test belief' });

    recordContradiction(db, id, 'obs 1');
    let b = getBelief(db, id)!;
    expect(b.status).toBe('active');

    recordContradiction(db, id, 'obs 2');
    b = getBelief(db, id)!;
    expect(b.status).toBe('challenged');
    expect(b.contradictions).toHaveLength(2);
  });

  it('does not downgrade a challenged belief back to active', () => {
    const id = addBelief(db, { statement: 'Test belief' });
    recordContradiction(db, id, 'obs 1');
    recordContradiction(db, id, 'obs 2');
    // Already challenged with 2, third shouldn't change anything
    recordContradiction(db, id, 'obs 3');
    const b = getBelief(db, id)!;
    expect(b.status).toBe('challenged');
    expect(b.contradictions).toHaveLength(3);
  });

  it('returns undefined for nonexistent belief', () => {
    expect(recordContradiction(db, 'nonexistent', 'obs')).toBeUndefined();
  });
});

describe('confirmBelief', () => {
  it('updates last_confirmed', () => {
    const id = addBelief(db, { statement: 'Test' });
    const before = getBelief(db, id)!;
    expect(before.last_confirmed).toBeNull();

    confirmBelief(db, id);
    const after = getBelief(db, id)!;
    expect(after.last_confirmed).not.toBeNull();
  });

  it('appends evidence when provided', () => {
    const id = addBelief(db, { statement: 'Test', evidence: ['initial'] });
    confirmBelief(db, id, 'new evidence');
    const b = getBelief(db, id)!;
    expect(b.evidence).toEqual(['initial', 'new evidence']);
  });

  it('does not add evidence when not provided', () => {
    const id = addBelief(db, { statement: 'Test', evidence: ['initial'] });
    confirmBelief(db, id);
    const b = getBelief(db, id)!;
    expect(b.evidence).toEqual(['initial']);
  });

  it('restores challenged belief to active with confidence boost', () => {
    const id = addBelief(db, { statement: 'Test', confidence: 0.7 });
    recordContradiction(db, id, 'obs 1');
    recordContradiction(db, id, 'obs 2');
    expect(getBelief(db, id)!.status).toBe('challenged');

    confirmBelief(db, id, 'reconfirmed');
    const b = getBelief(db, id)!;
    expect(b.status).toBe('active');
    expect(b.confidence).toBeCloseTo(0.8);
  });

  it('caps confidence at 1.0 when boosting', () => {
    const id = addBelief(db, { statement: 'Test', confidence: 0.95 });
    recordContradiction(db, id, 'obs 1');
    recordContradiction(db, id, 'obs 2');
    confirmBelief(db, id);
    const b = getBelief(db, id)!;
    expect(b.confidence).toBeLessThanOrEqual(1.0);
  });

  it('returns undefined for nonexistent belief', () => {
    expect(confirmBelief(db, 'nonexistent')).toBeUndefined();
  });
});

describe('reviseBelief', () => {
  it('updates statement and appends to revision history', () => {
    const id = addBelief(db, { statement: 'Old statement', confidence: 0.7 });
    reviseBelief(db, id, 'New statement', 'was wrong');
    const b = getBelief(db, id)!;
    expect(b.statement).toBe('New statement');
    expect(b.revision_history).toHaveLength(1);
    expect(b.revision_history[0].previous_statement).toBe('Old statement');
    expect(b.revision_history[0].previous_confidence).toBe(0.7);
    expect(b.revision_history[0].reason).toBe('was wrong');
  });

  it('clears contradictions and resets status to active', () => {
    const id = addBelief(db, { statement: 'Test' });
    recordContradiction(db, id, 'obs 1');
    recordContradiction(db, id, 'obs 2');
    expect(getBelief(db, id)!.status).toBe('challenged');

    reviseBelief(db, id, 'Updated statement', 'revised');
    const b = getBelief(db, id)!;
    expect(b.status).toBe('active');
    expect(b.contradictions).toEqual([]);
  });

  it('updates confidence when provided', () => {
    const id = addBelief(db, { statement: 'Test', confidence: 0.7 });
    reviseBelief(db, id, 'New', 'reason', 0.5);
    expect(getBelief(db, id)!.confidence).toBeCloseTo(0.5);
  });

  it('keeps existing confidence when not provided', () => {
    const id = addBelief(db, { statement: 'Test', confidence: 0.7 });
    reviseBelief(db, id, 'New', 'reason');
    expect(getBelief(db, id)!.confidence).toBeCloseTo(0.7);
  });

  it('clamps new confidence to [0, 1]', () => {
    const id = addBelief(db, { statement: 'Test' });
    reviseBelief(db, id, 'New', 'reason', 1.5);
    expect(getBelief(db, id)!.confidence).toBe(1);
  });

  it('returns undefined for nonexistent belief', () => {
    expect(reviseBelief(db, 'nonexistent', 'New', 'reason')).toBeUndefined();
  });
});

describe('retireBelief', () => {
  it('sets status to retired', () => {
    const id = addBelief(db, { statement: 'Test' });
    retireBelief(db, id, 'no longer relevant');
    const b = getBelief(db, id)!;
    expect(b.status).toBe('retired');
  });

  it('appends to revision history with Retired prefix', () => {
    const id = addBelief(db, { statement: 'Test', confidence: 0.7 });
    retireBelief(db, id, 'outdated');
    const b = getBelief(db, id)!;
    expect(b.revision_history).toHaveLength(1);
    expect(b.revision_history[0].reason).toBe('Retired: outdated');
    expect(b.revision_history[0].previous_statement).toBe('Test');
  });

  it('returns undefined for nonexistent belief', () => {
    expect(retireBelief(db, 'nonexistent', 'reason')).toBeUndefined();
  });
});

describe('getBeliefContext', () => {
  it('returns a header when no beliefs exist', () => {
    const ctx = getBeliefContext(db);
    expect(ctx).toContain('No active beliefs recorded');
  });

  it('groups beliefs by category in priority order', () => {
    addBelief(db, { statement: 'World fact', category: 'world' });
    addBelief(db, { statement: 'User pref', category: 'user' });
    addBelief(db, { statement: 'System thing', category: 'system' });
    addBelief(db, { statement: 'Self observation', category: 'self' });

    const ctx = getBeliefContext(db);
    const userIdx = ctx.indexOf('About the User');
    const systemIdx = ctx.indexOf('About the System');
    const worldIdx = ctx.indexOf('About the World');
    const selfIdx = ctx.indexOf('About Self');

    expect(userIdx).toBeLessThan(systemIdx);
    expect(systemIdx).toBeLessThan(worldIdx);
    expect(worldIdx).toBeLessThan(selfIdx);
  });

  it('marks challenged beliefs', () => {
    const id = addBelief(db, { statement: 'Disputed claim' });
    recordContradiction(db, id, 'obs 1');
    recordContradiction(db, id, 'obs 2');

    const ctx = getBeliefContext(db);
    expect(ctx).toContain('[CHALLENGED]');
  });

  it('excludes retired beliefs', () => {
    const id = addBelief(db, { statement: 'Retired belief' });
    retireBelief(db, id, 'done');
    const ctx = getBeliefContext(db);
    expect(ctx).not.toContain('Retired belief');
  });

  it('respects budget', () => {
    for (let i = 0; i < 20; i++) {
      addBelief(db, { statement: `Belief number ${i} with some extra words` });
    }
    const ctx = getBeliefContext(db, 200);
    expect(ctx.length).toBeLessThanOrEqual(200);
  });

  it('includes confidence percentage', () => {
    addBelief(db, { statement: 'Confident belief', confidence: 0.85 });
    const ctx = getBeliefContext(db);
    expect(ctx).toContain('85%');
  });
});

describe('getBeliefStats', () => {
  it('returns zeros for empty db', () => {
    const stats = getBeliefStats(db);
    expect(stats.total).toBe(0);
    expect(stats.byStatus.active).toBe(0);
    expect(stats.byCategory.user).toBe(0);
    expect(stats.totalContradictions).toBe(0);
    expect(stats.challenged).toHaveLength(0);
  });

  it('returns correct counts', () => {
    addBelief(db, { statement: 'B1', category: 'user' });
    addBelief(db, { statement: 'B2', category: 'world' });
    const id3 = addBelief(db, { statement: 'B3', category: 'system' });
    retireBelief(db, id3, 'done');

    const stats = getBeliefStats(db);
    expect(stats.total).toBe(3);
    expect(stats.byStatus.active).toBe(2);
    expect(stats.byStatus.retired).toBe(1);
    expect(stats.byCategory.user).toBe(1);
    expect(stats.byCategory.world).toBe(1);
    expect(stats.byCategory.system).toBe(1);
  });

  it('counts contradictions correctly', () => {
    const id = addBelief(db, { statement: 'Disputed' });
    recordContradiction(db, id, 'obs 1');
    recordContradiction(db, id, 'obs 2');

    const stats = getBeliefStats(db);
    expect(stats.totalContradictions).toBe(2);
  });

  it('lists challenged beliefs', () => {
    const id = addBelief(db, { statement: 'Challenged one' });
    recordContradiction(db, id, 'obs 1');
    recordContradiction(db, id, 'obs 2');

    const stats = getBeliefStats(db);
    expect(stats.challenged).toHaveLength(1);
    expect(stats.challenged[0].statement).toBe('Challenged one');
    expect(stats.challenged[0].contradictionCount).toBe(2);
  });
});

describe('containsNegation', () => {
  it('detects not + shared term', () => {
    expect(containsNegation('Kim does not prefer typescript', 'Kim prefers typescript')).toBe(true);
  });

  it('detects no longer + shared term', () => {
    expect(containsNegation('Kim no longer uses typescript', 'Kim uses typescript daily')).toBe(true);
  });

  it('returns false when no negation present', () => {
    expect(containsNegation('Kim prefers typescript', 'Kim prefers typescript')).toBe(false);
  });

  it('returns false when no shared key terms', () => {
    expect(containsNegation('Not a matching sentence', 'Completely different words here')).toBe(false);
  });

  it('detects stopped + shared term', () => {
    expect(containsNegation('Kim stopped using typescript', 'Kim regularly using typescript')).toBe(true);
  });
});

describe('hasConflictingNumericValues', () => {
  it('detects conflicting dollar amounts', () => {
    expect(hasConflictingNumericValues('Server costs $800', 'Server costs $500')).toBe(true);
  });

  it('returns false for similar values within 15%', () => {
    expect(hasConflictingNumericValues('Server costs $105', 'Server costs $100')).toBe(false);
  });

  it('returns false when no numbers in one string', () => {
    expect(hasConflictingNumericValues('No numbers here', 'Server costs $500')).toBe(false);
  });

  it('returns false when both have no numbers', () => {
    expect(hasConflictingNumericValues('No numbers', 'Also no numbers')).toBe(false);
  });

  it('handles zero values', () => {
    expect(hasConflictingNumericValues('Count is 0', 'Count is 5')).toBe(true);
  });

  it('returns false when both are zero', () => {
    expect(hasConflictingNumericValues('Count is 0', 'Count is 0')).toBe(false);
  });

  // Sensitivity-aware threshold tests (BRAIN-116)
  it('catches 9.4% difference at personal sensitivity (5% threshold)', () => {
    // Kim's income: $105 vs $96 = 9.4% difference — should be caught at personal
    expect(hasConflictingNumericValues('Income is $105', 'Income is $96', 'personal')).toBe(true);
  });

  it('misses 9.4% difference at approximate sensitivity (15% threshold)', () => {
    // Same values at default threshold — should NOT be caught
    expect(hasConflictingNumericValues('Income is $105', 'Income is $96', 'approximate')).toBe(false);
  });

  it('catches 9.4% at institutional sensitivity (10% threshold)', () => {
    expect(hasConflictingNumericValues('Income is $105', 'Income is $96', 'institutional')).toBe(false);
    // 10% threshold: ratio 1.09375 < 1.10 — just under, so false
  });

  it('catches 12% difference at institutional sensitivity', () => {
    // 112 vs 100 = 12% — should be caught at institutional (10%)
    expect(hasConflictingNumericValues('Count is 112', 'Count is 100', 'institutional')).toBe(true);
  });

  it('defaults to approximate (15%) when no sensitivity given', () => {
    // 14% difference — should NOT be caught with default
    expect(hasConflictingNumericValues('Population is 1140', 'Population is 1000')).toBe(false);
    // 16% difference — SHOULD be caught
    expect(hasConflictingNumericValues('Population is 1160', 'Population is 1000')).toBe(true);
  });
});

describe('parseApproxNumber', () => {
  it('parses plain integers', () => {
    expect(parseApproxNumber('128')).toBe(128);
  });

  it('parses dollar amounts', () => {
    expect(parseApproxNumber('$500')).toBe(500);
  });

  it('parses tilde prefix', () => {
    expect(parseApproxNumber('~500')).toBe(500);
  });

  it('parses K suffix', () => {
    expect(parseApproxNumber('500K')).toBe(500_000);
  });

  it('parses M suffix', () => {
    expect(parseApproxNumber('$1.27M')).toBeCloseTo(1_270_000);
  });

  it('parses B suffix', () => {
    expect(parseApproxNumber('2B')).toBe(2_000_000_000);
  });

  it('strips commas', () => {
    expect(parseApproxNumber('$1,000')).toBe(1000);
  });

  it('returns 0 for non-numeric input', () => {
    expect(parseApproxNumber('abc')).toBe(0);
  });
});

describe('prefix ID resolution', () => {
  it('getBelief resolves 8-char prefix', () => {
    const id = addBelief(db, { statement: 'Prefix test belief' });
    const prefix = id.slice(0, 8);
    const b = getBelief(db, prefix);
    expect(b).toBeDefined();
    expect(b!.id).toBe(id);
    expect(b!.statement).toBe('Prefix test belief');
  });

  it('confirmBelief works with prefix', () => {
    const id = addBelief(db, { statement: 'Confirm prefix test' });
    const prefix = id.slice(0, 8);
    const result = confirmBelief(db, prefix, 'prefix evidence');
    expect(result).toBeDefined();
    expect(result!.last_confirmed).toBeTruthy();
    expect(result!.evidence).toContain('prefix evidence');
  });

  it('recordContradiction works with prefix', () => {
    const id = addBelief(db, { statement: 'Contradict prefix test' });
    const prefix = id.slice(0, 8);
    const result = recordContradiction(db, prefix, 'contradicting observation');
    expect(result).toBeDefined();
    expect(result!.contradictions).toHaveLength(1);
  });

  it('reviseBelief works with prefix', () => {
    const id = addBelief(db, { statement: 'Revise prefix test' });
    const prefix = id.slice(0, 8);
    const result = reviseBelief(db, prefix, 'Revised statement', 'testing prefix');
    expect(result).toBeDefined();
    expect(result!.statement).toBe('Revised statement');
    expect(result!.revision_history).toHaveLength(1);
  });

  it('retireBelief works with prefix', () => {
    const id = addBelief(db, { statement: 'Retire prefix test' });
    const prefix = id.slice(0, 8);
    const result = retireBelief(db, prefix, 'testing prefix retirement');
    expect(result).toBeDefined();
    expect(result!.status).toBe('retired');
  });
});
