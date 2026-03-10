import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { compileDigest } from '../src/digest.js';
import { initDb, addCorrection } from '../src/db.js';
import { addBelief, reviseBelief, confirmBelief, recordContradiction } from '../src/beliefs.js';
import { addPrediction, resolvePrediction } from '../src/predictions.js';
import { initKnowledge, upsertKnowledge } from '../src/knowledge.js';

let db: Database.Database;

beforeEach(() => {
  db = initDb(':memory:');
  initKnowledge(db);
});

describe('compileDigest', () => {
  it('returns empty digest when no changes', () => {
    const result = compileDigest(db);
    expect(result.digest).toContain('No changes since');
    expect(result.stats.totalChanges).toBe(0);
    expect(result.sources).toHaveLength(0);
  });

  it('uses custom since date', () => {
    const result = compileDigest(db, { since: '2020-01-01T00:00:00.000Z' });
    // Should still be empty since no data exists
    expect(result.stats.totalChanges).toBe(0);
  });

  it('includes resolved predictions', () => {
    const id = addPrediction(db, {
      topic: 'Test prediction',
      prediction: 'Something will happen',
      confidence: 0.7,
    });
    resolvePrediction(db, id, 'correct', 'It happened');

    const result = compileDigest(db, { since: '2020-01-01T00:00:00.000Z' });
    expect(result.stats.predictionsResolved).toBe(1);
    expect(result.digest).toContain('Predictions Resolved');
    expect(result.digest).toContain('Test prediction');
    expect(result.digest).toContain('70%');
    expect(result.digest).toContain('✅');
  });

  it('shows ❌ for incorrect predictions', () => {
    const id = addPrediction(db, {
      topic: 'Wrong prediction',
      prediction: 'This will not happen',
      confidence: 0.8,
    });
    resolvePrediction(db, id, 'incorrect', 'It did not happen');

    const result = compileDigest(db, { since: '2020-01-01T00:00:00.000Z' });
    expect(result.digest).toContain('❌');
    expect(result.digest).toContain('Wrong prediction');
  });

  it('shows ◐ for partial predictions', () => {
    const id = addPrediction(db, {
      topic: 'Partial prediction',
      prediction: 'Partially true',
      confidence: 0.5,
    });
    resolvePrediction(db, id, 'partial', 'Kind of happened');

    const result = compileDigest(db, { since: '2020-01-01T00:00:00.000Z' });
    expect(result.digest).toContain('◐');
  });

  it('includes changed beliefs', () => {
    const id = addBelief(db, {
      statement: 'The sky is blue',
      confidence: 0.9,
      category: 'world',
    });
    // Confirm to trigger last_confirmed update
    confirmBelief(db, id, 'Looked outside');

    const result = compileDigest(db, { since: '2020-01-01T00:00:00.000Z' });
    expect(result.stats.beliefsChanged).toBeGreaterThanOrEqual(1);
    expect(result.digest).toContain('Beliefs Changed');
    expect(result.digest).toContain('The sky is blue');
  });

  it('includes revised beliefs with marker', () => {
    const id = addBelief(db, {
      statement: 'Original belief',
      confidence: 0.8,
      category: 'world',
    });
    reviseBelief(db, id, 'Revised belief', 'New evidence', 0.6);

    const result = compileDigest(db, { since: '2020-01-01T00:00:00.000Z' });
    expect(result.stats.beliefsChanged).toBeGreaterThanOrEqual(1);
    expect(result.digest).toContain('📝');
  });

  it('includes challenged beliefs with marker', () => {
    const id = addBelief(db, {
      statement: 'Challenged belief',
      confidence: 0.7,
      category: 'world',
    });
    recordContradiction(db, id, 'Counter-evidence found', 'Contradicts existing data');

    const result = compileDigest(db, { since: '2020-01-01T00:00:00.000Z' });
    expect(result.stats.beliefsChanged).toBeGreaterThanOrEqual(1);
    expect(result.digest).toContain('⚠️');
  });

  it('includes new corrections', () => {
    addCorrection(db, {
      type: 'fact',
      content: 'Kim earns $105/hr not $96',
      permanence: 'never',
    });

    const result = compileDigest(db, { since: '2020-01-01T00:00:00.000Z' });
    expect(result.stats.correctionsAdded).toBe(1);
    expect(result.digest).toContain('Corrections Added');
    expect(result.digest).toContain('Kim earns');
    expect(result.digest).toContain('[fact]');
  });

  it('includes updated knowledge entries', () => {
    upsertKnowledge(db, { type: 'context', key: 'test-key', content: 'Some context content' });

    const result = compileDigest(db, { since: '2020-01-01T00:00:00.000Z' });
    expect(result.stats.knowledgeUpdated).toBeGreaterThanOrEqual(1);
    expect(result.digest).toContain('Knowledge Updated');
    expect(result.digest).toContain('context');
    expect(result.sources.length).toBeGreaterThan(0);
  });

  it('includes calibration stats when requested', () => {
    const id1 = addPrediction(db, {
      topic: 'P1',
      prediction: 'Yes',
      confidence: 0.8,
    });
    const id2 = addPrediction(db, {
      topic: 'P2',
      prediction: 'No',
      confidence: 0.6,
    });
    resolvePrediction(db, id1, 'correct', 'Yes');
    resolvePrediction(db, id2, 'incorrect', 'Oops');

    const result = compileDigest(db, {
      since: '2020-01-01T00:00:00.000Z',
      includeCalibration: true,
    });
    expect(result.digest).toContain('Calibration');
    expect(result.digest).toContain('Resolved: 2 predictions');
    expect(result.digest).toContain('50.0%');
  });

  it('excludes calibration when disabled', () => {
    const id = addPrediction(db, {
      topic: 'P1',
      prediction: 'Yes',
      confidence: 0.8,
    });
    resolvePrediction(db, id, 'correct', 'Yes');

    const result = compileDigest(db, {
      since: '2020-01-01T00:00:00.000Z',
      includeCalibration: false,
    });
    expect(result.digest).not.toContain('Calibration');
  });

  it('respects budget limit', () => {
    // Create many entries to exceed a small budget
    for (let i = 0; i < 10; i++) {
      const id = addPrediction(db, {
        topic: `Prediction ${i} with a very long topic name to use up budget space quickly`,
        prediction: 'Something with lots of text to fill up the budget allocation',
        confidence: 0.5 + i * 0.05,
      });
      resolvePrediction(db, id, 'correct', 'Done');
    }

    const result = compileDigest(db, {
      since: '2020-01-01T00:00:00.000Z',
      budget: 500,
    });
    expect(result.digest.length).toBeLessThanOrEqual(500);
  });

  it('provides summary line with counts', () => {
    const predId = addPrediction(db, {
      topic: 'P1',
      prediction: 'Yes',
      confidence: 0.8,
    });
    resolvePrediction(db, predId, 'correct', 'Yes');

    addCorrection(db, {
      type: 'pattern',
      content: 'Always verify dates',
      permanence: 'graduable',
    });

    const result = compileDigest(db, { since: '2020-01-01T00:00:00.000Z' });
    expect(result.digest).toContain('1 predictions resolved');
    expect(result.digest).toContain('1 corrections added');
  });

  it('computes totalChanges as sum of all categories', () => {
    const predId = addPrediction(db, {
      topic: 'P1',
      prediction: 'Yes',
      confidence: 0.7,
    });
    resolvePrediction(db, predId, 'correct', 'Yes');

    addCorrection(db, {
      type: 'fact',
      content: 'Some fact',
      permanence: 'never',
    });

    upsertKnowledge(db, { type: 'handoff', key: 'test', content: 'Content' });

    const result = compileDigest(db, { since: '2020-01-01T00:00:00.000Z' });
    expect(result.stats.totalChanges).toBe(
      result.stats.predictionsResolved +
      result.stats.beliefsChanged +
      result.stats.correctionsAdded +
      result.stats.positionsShifted +
      result.stats.knowledgeUpdated,
    );
    expect(result.stats.totalChanges).toBeGreaterThanOrEqual(3);
  });

  it('truncates long topic names and predictions', () => {
    const longTopic = 'A'.repeat(100);
    const id = addPrediction(db, {
      topic: longTopic,
      prediction: 'B'.repeat(200),
      confidence: 0.5,
    });
    resolvePrediction(db, id, 'correct', 'Done');

    const result = compileDigest(db, { since: '2020-01-01T00:00:00.000Z' });
    // Topic truncated to 50 chars + '...'
    expect(result.digest).toContain('A'.repeat(47) + '...');
  });

  it('handles multiple types of changes together', () => {
    // Prediction
    const predId = addPrediction(db, {
      topic: 'Combined test',
      prediction: 'Everything works',
      confidence: 0.9,
    });
    resolvePrediction(db, predId, 'correct', 'Yes');

    // Belief
    const beliefId = addBelief(db, {
      statement: 'Combined belief',
      confidence: 0.8,
      category: 'system',
    });
    confirmBelief(db, beliefId);

    // Correction
    addCorrection(db, {
      type: 'technical',
      content: 'Combined correction',
      permanence: 'conditional',
    });

    // Knowledge
    upsertKnowledge(db, { type: 'research', key: 'combined', content: 'Combined research' });

    const result = compileDigest(db, { since: '2020-01-01T00:00:00.000Z' });
    expect(result.stats.predictionsResolved).toBe(1);
    expect(result.stats.beliefsChanged).toBeGreaterThanOrEqual(1);
    expect(result.stats.correctionsAdded).toBe(1);
    expect(result.stats.knowledgeUpdated).toBeGreaterThanOrEqual(1);
    expect(result.digest).toContain('Predictions Resolved');
    expect(result.digest).toContain('Beliefs Changed');
    expect(result.digest).toContain('Corrections Added');
    expect(result.digest).toContain('Knowledge Updated');
  });
});
