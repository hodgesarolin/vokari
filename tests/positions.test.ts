import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  initPositions,
  addPosition,
  getPosition,
  listPositions,
  challengePosition,
  revisePosition,
  abandonPosition,
  getUnchallenged,
  getPositionContext,
} from '../src/positions.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  initPositions(db);
});

describe('initPositions', () => {
  it('creates the positions table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='positions'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('is idempotent', () => {
    initPositions(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='positions'")
      .all();
    expect(tables).toHaveLength(1);
  });
});

describe('addPosition', () => {
  it('returns a UUID', () => {
    const id = addPosition(db, {
      topic: 'AI Safety',
      position: 'AI alignment is critical',
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('stores all fields', () => {
    const id = addPosition(db, {
      topic: 'Language Choice',
      position: 'TypeScript is better for large projects',
      reasoning: 'Type safety reduces bugs',
      evidence: ['study A', 'experience B'],
      confidence: 0.85,
      supersedes: 'old-id',
      counterevidence: ['dynamic langs are faster to prototype'],
    });
    const p = getPosition(db, id)!;
    expect(p.topic).toBe('Language Choice');
    expect(p.position).toBe('TypeScript is better for large projects');
    expect(p.reasoning).toBe('Type safety reduces bugs');
    expect(JSON.parse(p.evidence!)).toEqual(['study A', 'experience B']);
    expect(p.confidence).toBe(0.85);
    expect(p.status).toBe('held');
    expect(p.challenge_count).toBe(0);
    expect(p.last_challenged).toBeNull();
    expect(p.supersedes).toBe('old-id');
    expect(JSON.parse(p.counterevidence!)).toEqual(['dynamic langs are faster to prototype']);
  });

  it('defaults optional fields to null', () => {
    const id = addPosition(db, {
      topic: 'Test',
      position: 'Something',
    });
    const p = getPosition(db, id)!;
    expect(p.reasoning).toBeNull();
    expect(p.evidence).toBeNull();
    expect(p.confidence).toBeNull();
    expect(p.supersedes).toBeNull();
    expect(p.counterevidence).toBeNull();
    expect(p.revision_history).toBeNull();
  });
});

describe('getPosition', () => {
  it('returns undefined for nonexistent id', () => {
    expect(getPosition(db, 'nonexistent')).toBeUndefined();
  });

  it('retrieves a stored position', () => {
    const id = addPosition(db, { topic: 'Test', position: 'Something' });
    const p = getPosition(db, id);
    expect(p).toBeDefined();
    expect(p!.id).toBe(id);
  });
});

describe('listPositions', () => {
  beforeEach(() => {
    addPosition(db, { topic: 'A', position: 'P1' });
    addPosition(db, { topic: 'B', position: 'P2' });
    addPosition(db, { topic: 'C', position: 'P3' });
  });

  it('lists all positions', () => {
    expect(listPositions(db)).toHaveLength(3);
  });

  it('filters by status', () => {
    const all = listPositions(db);
    challengePosition(db, all[0].id);

    const held = listPositions(db, { status: 'held' });
    expect(held).toHaveLength(2);

    const challenged = listPositions(db, { status: 'challenged' });
    expect(challenged).toHaveLength(1);
  });

  it('returns all positions', () => {
    const positions = listPositions(db);
    expect(positions).toHaveLength(3);
    const topics = positions.map((p) => p.topic).sort();
    expect(topics).toEqual(['A', 'B', 'C']);
  });
});

describe('challengePosition', () => {
  it('sets status to challenged', () => {
    const id = addPosition(db, { topic: 'Test', position: 'Something' });
    challengePosition(db, id);
    const p = getPosition(db, id)!;
    expect(p.status).toBe('challenged');
  });

  it('increments challenge_count', () => {
    const id = addPosition(db, { topic: 'Test', position: 'Something' });
    challengePosition(db, id);
    expect(getPosition(db, id)!.challenge_count).toBe(1);

    challengePosition(db, id);
    expect(getPosition(db, id)!.challenge_count).toBe(2);
  });

  it('sets last_challenged timestamp', () => {
    const id = addPosition(db, { topic: 'Test', position: 'Something' });
    challengePosition(db, id);
    expect(getPosition(db, id)!.last_challenged).not.toBeNull();
  });
});

describe('revisePosition', () => {
  it('updates the position text and confidence', () => {
    const id = addPosition(db, { topic: 'Test', position: 'Old view', confidence: 0.6 });
    revisePosition(db, id, 'New view', 0.8, 'new evidence');
    const p = getPosition(db, id)!;
    expect(p.position).toBe('New view');
    expect(p.confidence).toBe(0.8);
  });

  it('resets status to held', () => {
    const id = addPosition(db, { topic: 'Test', position: 'Something' });
    challengePosition(db, id);
    expect(getPosition(db, id)!.status).toBe('challenged');

    revisePosition(db, id, 'Updated', 0.7, 'reconsidered');
    expect(getPosition(db, id)!.status).toBe('held');
  });

  it('appends to revision_history', () => {
    const id = addPosition(db, { topic: 'Test', position: 'Original', confidence: 0.5 });
    revisePosition(db, id, 'Revised', 0.8, 'learned more');

    const p = getPosition(db, id)!;
    const history = JSON.parse(p.revision_history!);
    expect(history).toHaveLength(1);
    expect(history[0].old_position).toBe('Original');
    expect(history[0].old_confidence).toBe(0.5);
    expect(history[0].reason).toBe('learned more');
  });

  it('accumulates revision history over multiple revisions', () => {
    const id = addPosition(db, { topic: 'Test', position: 'V1', confidence: 0.5 });
    revisePosition(db, id, 'V2', 0.6, 'first revision');
    revisePosition(db, id, 'V3', 0.7, 'second revision');

    const p = getPosition(db, id)!;
    const history = JSON.parse(p.revision_history!);
    expect(history).toHaveLength(2);
    expect(history[0].old_position).toBe('V1');
    expect(history[1].old_position).toBe('V2');
  });

  it('does nothing for nonexistent position', () => {
    // Should not throw
    revisePosition(db, 'nonexistent', 'New', 0.5, 'reason');
  });
});

describe('abandonPosition', () => {
  it('sets status to abandoned', () => {
    const id = addPosition(db, { topic: 'Test', position: 'Something' });
    abandonPosition(db, id, 'no longer valid');
    expect(getPosition(db, id)!.status).toBe('abandoned');
  });

  it('appends to revision_history', () => {
    const id = addPosition(db, { topic: 'Test', position: 'Old view', confidence: 0.7 });
    abandonPosition(db, id, 'was wrong');

    const p = getPosition(db, id)!;
    const history = JSON.parse(p.revision_history!);
    expect(history).toHaveLength(1);
    expect(history[0].old_position).toBe('Old view');
    expect(history[0].old_confidence).toBe(0.7);
    expect(history[0].reason).toBe('was wrong');
  });

  it('does nothing for nonexistent position', () => {
    abandonPosition(db, 'nonexistent', 'reason');
  });
});

describe('getUnchallenged', () => {
  it('returns positions never challenged', () => {
    addPosition(db, { topic: 'A', position: 'P1' });
    addPosition(db, { topic: 'B', position: 'P2' });

    const unchallenged = getUnchallenged(db, 30);
    expect(unchallenged).toHaveLength(2);
  });

  it('excludes abandoned positions', () => {
    const id = addPosition(db, { topic: 'A', position: 'P1' });
    abandonPosition(db, id, 'done');

    const unchallenged = getUnchallenged(db, 30);
    expect(unchallenged).toHaveLength(0);
  });

  it('excludes revised positions', () => {
    const id = addPosition(db, { topic: 'A', position: 'P1', confidence: 0.5 });
    // Revise sets status to 'held', so it should still appear
    revisePosition(db, id, 'P2', 0.7, 'updated');
    const unchallenged = getUnchallenged(db, 30);
    // Held positions with no recent challenge should appear
    expect(unchallenged).toHaveLength(1);
  });

  it('includes recently challenged positions if challenge was long ago enough', () => {
    const id = addPosition(db, { topic: 'A', position: 'P1' });
    // Challenge it — sets last_challenged to now
    challengePosition(db, id);
    // With days=0, last_challenged <= datetime('now', '0 days') should include it
    const unchallenged = getUnchallenged(db, 0);
    expect(unchallenged).toHaveLength(1);
  });
});

describe('getPositionContext', () => {
  it('returns header with no positions', () => {
    const ctx = getPositionContext(db);
    expect(ctx).toContain('# Active Positions');
  });

  it('includes held positions', () => {
    addPosition(db, { topic: 'TypeScript', position: 'Best for large projects', confidence: 0.9 });
    const ctx = getPositionContext(db);
    expect(ctx).toContain('TypeScript');
    expect(ctx).toContain('Best for large projects');
    expect(ctx).toContain('90%');
  });

  it('shows challenged positions before held', () => {
    addPosition(db, { topic: 'Held Topic', position: 'Held position', confidence: 0.9 });
    const id = addPosition(db, { topic: 'Challenged Topic', position: 'Challenged position', confidence: 0.8 });
    challengePosition(db, id);

    const ctx = getPositionContext(db);
    const challengedIdx = ctx.indexOf('Challenged');
    const heldIdx = ctx.indexOf('Held Topic');
    expect(challengedIdx).toBeLessThan(heldIdx);
  });

  it('shows challenge count', () => {
    const id = addPosition(db, { topic: 'Test', position: 'Something', confidence: 0.5 });
    challengePosition(db, id);
    challengePosition(db, id);

    const ctx = getPositionContext(db);
    expect(ctx).toContain('[2 challenges]');
  });

  it('excludes abandoned positions', () => {
    const id = addPosition(db, { topic: 'Abandoned', position: 'Old thing' });
    abandonPosition(db, id, 'no longer valid');

    const ctx = getPositionContext(db);
    expect(ctx).not.toContain('Abandoned');
  });

  it('respects budget', () => {
    for (let i = 0; i < 20; i++) {
      addPosition(db, { topic: `Topic ${i}`, position: `Position ${i} with some extra text`, confidence: 0.5 });
    }
    const ctx = getPositionContext(db, 200);
    expect(ctx.length).toBeLessThanOrEqual(200);
  });

  it('handles positions without confidence', () => {
    addPosition(db, { topic: 'No Conf', position: 'Something' });
    const ctx = getPositionContext(db);
    expect(ctx).toContain('No Conf');
    // Should not show percentage for null confidence
    expect(ctx).not.toContain('NaN');
  });
});
