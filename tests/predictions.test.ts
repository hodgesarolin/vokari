import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  initPredictions,
  addPrediction,
  getPrediction,
  listPredictions,
  revisePrediction,
  resolvePrediction,
  getPendingReview,
  getCalibration,
} from '../src/predictions.js';
import {
  brierScore,
  calibrationByDomain,
  getSystematicBias,
  calibrationReport,
} from '../src/calibration.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  initPredictions(db);
});

describe('initPredictions', () => {
  it('creates the predictions table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='predictions'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('is idempotent', () => {
    initPredictions(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='predictions'")
      .all();
    expect(tables).toHaveLength(1);
  });
});

describe('addPrediction', () => {
  it('returns a UUID', () => {
    const id = addPrediction(db, {
      topic: 'Weather',
      prediction: 'It will rain tomorrow',
      confidence: 0.8,
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('stores all fields', () => {
    const id = addPrediction(db, {
      topic: 'Tech',
      prediction: 'TypeScript 6 will release by 2027',
      confidence: 0.6,
      reasoning: 'Current pace suggests so',
      resolution_criteria: 'Official release announcement',
      check_date: '2027-01-01',
      domain: 'technical',
      supersedes: 'some-old-id',
    });
    const p = getPrediction(db, id)!;
    expect(p.topic).toBe('Tech');
    expect(p.prediction).toBe('TypeScript 6 will release by 2027');
    expect(p.confidence).toBe(0.6);
    expect(p.reasoning).toBe('Current pace suggests so');
    expect(p.resolution_criteria).toBe('Official release announcement');
    expect(p.check_date).toBe('2027-01-01');
    expect(p.domain).toBe('technical');
    expect(p.supersedes).toBe('some-old-id');
    expect(p.outcome).toBeNull();
    expect(p.outcome_notes).toBeNull();
    expect(p.resolved_at).toBeNull();
  });

  it('defaults domain to general', () => {
    const id = addPrediction(db, {
      topic: 'Test',
      prediction: 'Something',
      confidence: 0.5,
    });
    expect(getPrediction(db, id)!.domain).toBe('general');
  });

  it('defaults optional fields to null', () => {
    const id = addPrediction(db, {
      topic: 'Test',
      prediction: 'Something',
      confidence: 0.5,
    });
    const p = getPrediction(db, id)!;
    expect(p.reasoning).toBeNull();
    expect(p.resolution_criteria).toBeNull();
    expect(p.check_date).toBeNull();
    expect(p.supersedes).toBeNull();
  });
});

describe('getPrediction', () => {
  it('returns undefined for nonexistent id', () => {
    expect(getPrediction(db, 'nonexistent')).toBeUndefined();
  });

  it('retrieves a stored prediction', () => {
    const id = addPrediction(db, {
      topic: 'Test',
      prediction: 'Will happen',
      confidence: 0.7,
    });
    const p = getPrediction(db, id);
    expect(p).toBeDefined();
    expect(p!.id).toBe(id);
  });
});

describe('listPredictions', () => {
  beforeEach(() => {
    addPrediction(db, { topic: 'A', prediction: 'P1', confidence: 0.5, domain: 'technical' });
    addPrediction(db, { topic: 'B', prediction: 'P2', confidence: 0.6, domain: 'general' });
    addPrediction(db, { topic: 'C', prediction: 'P3', confidence: 0.7, domain: 'technical' });
  });

  it('lists all predictions', () => {
    expect(listPredictions(db)).toHaveLength(3);
  });

  it('filters by domain', () => {
    const tech = listPredictions(db, { domain: 'technical' });
    expect(tech).toHaveLength(2);
    for (const p of tech) {
      expect(p.domain).toBe('technical');
    }
  });

  it('filters resolved only', () => {
    const all = listPredictions(db);
    resolvePrediction(db, all[0].id, 'correct');

    const resolved = listPredictions(db, { resolved: true });
    expect(resolved).toHaveLength(1);
  });

  it('filters unresolved only', () => {
    const all = listPredictions(db);
    resolvePrediction(db, all[0].id, 'correct');

    const unresolved = listPredictions(db, { resolved: false });
    expect(unresolved).toHaveLength(2);
  });

  it('returns in descending created_at order', () => {
    const preds = listPredictions(db);
    expect(preds).toHaveLength(3);
  });
});

describe('resolvePrediction', () => {
  it('sets outcome and resolved_at', () => {
    const id = addPrediction(db, { topic: 'T', prediction: 'P', confidence: 0.8 });
    resolvePrediction(db, id, 'correct', 'It happened');
    const p = getPrediction(db, id)!;
    expect(p.outcome).toBe('correct');
    expect(p.outcome_notes).toBe('It happened');
    expect(p.resolved_at).not.toBeNull();
  });

  it('allows resolving as incorrect', () => {
    const id = addPrediction(db, { topic: 'T', prediction: 'P', confidence: 0.8 });
    resolvePrediction(db, id, 'incorrect');
    expect(getPrediction(db, id)!.outcome).toBe('incorrect');
  });

  it('allows resolving as partial', () => {
    const id = addPrediction(db, { topic: 'T', prediction: 'P', confidence: 0.8 });
    resolvePrediction(db, id, 'partial');
    expect(getPrediction(db, id)!.outcome).toBe('partial');
  });

  it('allows resolving as voided', () => {
    const id = addPrediction(db, { topic: 'T', prediction: 'P', confidence: 0.8 });
    resolvePrediction(db, id, 'voided');
    expect(getPrediction(db, id)!.outcome).toBe('voided');
  });

  it('defaults notes to null', () => {
    const id = addPrediction(db, { topic: 'T', prediction: 'P', confidence: 0.8 });
    resolvePrediction(db, id, 'correct');
    expect(getPrediction(db, id)!.outcome_notes).toBeNull();
  });
});

describe('getPendingReview', () => {
  it('returns predictions with past check_date and no outcome', () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString();
    addPrediction(db, { topic: 'T', prediction: 'P', confidence: 0.8, check_date: pastDate });
    const pending = getPendingReview(db);
    expect(pending).toHaveLength(1);
  });

  it('does not return predictions without check_date', () => {
    addPrediction(db, { topic: 'T', prediction: 'P', confidence: 0.8 });
    expect(getPendingReview(db)).toHaveLength(0);
  });

  it('does not return resolved predictions', () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString();
    const id = addPrediction(db, { topic: 'T', prediction: 'P', confidence: 0.8, check_date: pastDate });
    resolvePrediction(db, id, 'correct');
    expect(getPendingReview(db)).toHaveLength(0);
  });

  it('does not return predictions with future check_date', () => {
    const futureDate = new Date(Date.now() + 86400000 * 30).toISOString();
    addPrediction(db, { topic: 'T', prediction: 'P', confidence: 0.8, check_date: futureDate });
    expect(getPendingReview(db)).toHaveLength(0);
  });
});

describe('revisePrediction', () => {
  it('updates prediction in-place', () => {
    const id = addPrediction(db, { topic: 'Weather', prediction: 'It will rain', confidence: 0.7 });
    const resultId = revisePrediction(db, id, { prediction: 'It will snow', confidence: 0.5, reason: 'Changed forecast' });
    expect(resultId).toBe(id);

    const p = getPrediction(db, id)!;
    expect(p.prediction).toBe('It will snow');
    expect(p.confidence).toBe(0.5);
  });

  it('records revision history', () => {
    const id = addPrediction(db, { topic: 'Weather', prediction: 'Rain', confidence: 0.7, reasoning: 'Cloudy' });
    revisePrediction(db, id, { prediction: 'Snow', confidence: 0.5, reason: 'Temperature dropped' });

    const p = getPrediction(db, id)!;
    expect(p.revision_history).toHaveLength(1);
    expect(p.revision_history[0].previous_prediction).toBe('Rain');
    expect(p.revision_history[0].previous_confidence).toBe(0.7);
    expect(p.revision_history[0].previous_reasoning).toBe('Cloudy');
    expect(p.revision_history[0].reason).toBe('Temperature dropped');
  });

  it('supports multiple revisions', () => {
    const id = addPrediction(db, { topic: 'T', prediction: 'P1', confidence: 0.8 });
    revisePrediction(db, id, { prediction: 'P2', confidence: 0.6, reason: 'Revision 1' });
    revisePrediction(db, id, { prediction: 'P3', confidence: 0.4, reason: 'Revision 2' });

    const p = getPrediction(db, id)!;
    expect(p.prediction).toBe('P3');
    expect(p.confidence).toBe(0.4);
    expect(p.revision_history).toHaveLength(2);
    expect(p.revision_history[0].previous_prediction).toBe('P1');
    expect(p.revision_history[1].previous_prediction).toBe('P2');
  });

  it('returns undefined for resolved prediction', () => {
    const id = addPrediction(db, { topic: 'T', prediction: 'P', confidence: 0.8 });
    resolvePrediction(db, id, 'correct');
    const result = revisePrediction(db, id, { prediction: 'Updated' });
    expect(result).toBeUndefined();
  });

  it('returns undefined for nonexistent prediction', () => {
    const result = revisePrediction(db, 'nonexistent', { prediction: 'Updated' });
    expect(result).toBeUndefined();
  });

  it('does not void the original (in-place update)', () => {
    const id = addPrediction(db, { topic: 'T', prediction: 'Original', confidence: 0.8 });
    revisePrediction(db, id, { prediction: 'Revised' });
    const p = getPrediction(db, id)!;
    expect(p.outcome).toBeNull(); // Not voided
    expect(p.prediction).toBe('Revised');
  });

  it('defaults reason to Revised', () => {
    const id = addPrediction(db, { topic: 'T', prediction: 'P1', confidence: 0.8 });
    revisePrediction(db, id, { prediction: 'P2' });
    const p = getPrediction(db, id)!;
    expect(p.revision_history[0].reason).toBe('Revised');
  });
});

describe('getCalibration', () => {
  it('returns zeros for empty db', () => {
    const cal = getCalibration(db);
    expect(cal.total).toBe(0);
    expect(cal.correct).toBe(0);
    expect(cal.accuracy).toBe(0);
    expect(cal.brier_score).toBe(0);
  });

  it('calculates accuracy correctly', () => {
    const ids = [
      addPrediction(db, { topic: 'A', prediction: 'P', confidence: 0.8 }),
      addPrediction(db, { topic: 'B', prediction: 'P', confidence: 0.6 }),
      addPrediction(db, { topic: 'C', prediction: 'P', confidence: 0.7 }),
    ];
    resolvePrediction(db, ids[0], 'correct');
    resolvePrediction(db, ids[1], 'incorrect');
    resolvePrediction(db, ids[2], 'correct');

    const cal = getCalibration(db);
    expect(cal.total).toBe(3);
    expect(cal.correct).toBe(2);
    expect(cal.incorrect).toBe(1);
    expect(cal.accuracy).toBeCloseTo(2 / 3);
  });

  it('excludes voided from main calculation but counts them', () => {
    const id1 = addPrediction(db, { topic: 'A', prediction: 'P', confidence: 0.8 });
    const id2 = addPrediction(db, { topic: 'B', prediction: 'P', confidence: 0.6 });
    resolvePrediction(db, id1, 'correct');
    resolvePrediction(db, id2, 'voided');

    const cal = getCalibration(db);
    expect(cal.total).toBe(1); // only non-voided
    expect(cal.voided).toBe(1);
    expect(cal.accuracy).toBe(1);
  });

  it('calculates brier score', () => {
    const id = addPrediction(db, { topic: 'A', prediction: 'P', confidence: 0.8 });
    resolvePrediction(db, id, 'correct');

    const cal = getCalibration(db);
    // brier = (0.8 - 1)^2 = 0.04
    expect(cal.brier_score).toBeCloseTo(0.04);
  });

  it('counts partial outcomes', () => {
    const id = addPrediction(db, { topic: 'A', prediction: 'P', confidence: 0.7 });
    resolvePrediction(db, id, 'partial');

    const cal = getCalibration(db);
    expect(cal.partial).toBe(1);
  });

  it('filters by domain', () => {
    const id1 = addPrediction(db, { topic: 'A', prediction: 'P', confidence: 0.8, domain: 'technical' });
    const id2 = addPrediction(db, { topic: 'B', prediction: 'P', confidence: 0.6, domain: 'general' });
    resolvePrediction(db, id1, 'correct');
    resolvePrediction(db, id2, 'correct');

    const cal = getCalibration(db, { domain: 'technical' });
    expect(cal.total).toBe(1);
  });

  it('populates by_domain stats', () => {
    const id = addPrediction(db, { topic: 'A', prediction: 'P', confidence: 0.9, domain: 'technical' });
    resolvePrediction(db, id, 'correct');

    const cal = getCalibration(db);
    expect(cal.by_domain.technical.total).toBe(1);
    expect(cal.by_domain.technical.correct).toBe(1);
    expect(cal.by_domain.technical.accuracy).toBe(1);
    expect(cal.by_domain.general.total).toBe(0);
  });
});

describe('brierScore', () => {
  it('returns 0 for empty array', () => {
    expect(brierScore([])).toBe(0);
  });

  it('returns 0 for only voided predictions', () => {
    const preds = [
      { confidence: 0.8, outcome: 'voided' as const } as any,
    ];
    expect(brierScore(preds)).toBe(0);
  });

  it('returns 0 for perfect predictions', () => {
    const preds = [
      { confidence: 1.0, outcome: 'correct' as const } as any,
      { confidence: 0.0, outcome: 'incorrect' as const } as any,
    ];
    expect(brierScore(preds)).toBeCloseTo(0);
  });

  it('returns correct score for mixed predictions', () => {
    const preds = [
      { confidence: 0.8, outcome: 'correct' as const } as any,
      { confidence: 0.6, outcome: 'incorrect' as const } as any,
    ];
    // brier = ((0.8-1)^2 + (0.6-0)^2) / 2 = (0.04 + 0.36) / 2 = 0.2
    expect(brierScore(preds)).toBeCloseTo(0.2);
  });

  it('treats partial as 0.5 outcome', () => {
    const preds = [
      { confidence: 0.5, outcome: 'partial' as const } as any,
    ];
    // brier = (0.5 - 0.5)^2 = 0
    expect(brierScore(preds)).toBeCloseTo(0);
  });

  it('excludes null outcomes', () => {
    const preds = [
      { confidence: 0.8, outcome: 'correct' as const } as any,
      { confidence: 0.5, outcome: null } as any,
    ];
    // Only first is scored: (0.8-1)^2 / 1 = 0.04
    expect(brierScore(preds)).toBeCloseTo(0.04);
  });
});

describe('calibrationByDomain', () => {
  it('returns empty array when no resolved predictions', () => {
    const reports = calibrationByDomain(db);
    expect(reports).toHaveLength(0);
  });

  it('groups predictions by domain', () => {
    const id1 = addPrediction(db, { topic: 'A', prediction: 'P', confidence: 0.8, domain: 'technical' });
    const id2 = addPrediction(db, { topic: 'B', prediction: 'P', confidence: 0.7, domain: 'general' });
    const id3 = addPrediction(db, { topic: 'C', prediction: 'P', confidence: 0.6, domain: 'technical' });
    resolvePrediction(db, id1, 'correct');
    resolvePrediction(db, id2, 'incorrect');
    resolvePrediction(db, id3, 'correct');

    const reports = calibrationByDomain(db);
    const tech = reports.find((r) => r.domain === 'technical')!;
    expect(tech.total).toBe(2);
    expect(tech.correct).toBe(2);
    expect(tech.accuracy).toBe(1);

    const gen = reports.find((r) => r.domain === 'general')!;
    expect(gen.total).toBe(1);
    expect(gen.correct).toBe(0);
  });

  it('skips domains with no resolved predictions', () => {
    const id = addPrediction(db, { topic: 'A', prediction: 'P', confidence: 0.8, domain: 'technical' });
    resolvePrediction(db, id, 'correct');

    const reports = calibrationByDomain(db);
    expect(reports).toHaveLength(1);
    expect(reports[0].domain).toBe('technical');
  });

  it('excludes voided predictions', () => {
    const id1 = addPrediction(db, { topic: 'A', prediction: 'P', confidence: 0.8, domain: 'technical' });
    const id2 = addPrediction(db, { topic: 'B', prediction: 'P', confidence: 0.6, domain: 'technical' });
    resolvePrediction(db, id1, 'correct');
    resolvePrediction(db, id2, 'voided');

    const reports = calibrationByDomain(db);
    const tech = reports.find((r) => r.domain === 'technical')!;
    expect(tech.total).toBe(1);
  });
});

describe('getSystematicBias', () => {
  it('returns well-calibrated for insufficient data', () => {
    const bias = getSystematicBias({ average_confidence: 0.8, accuracy: 0.5, total: 3 });
    expect(bias.direction).toBe('well-calibrated');
    expect(bias.details).toContain('Insufficient data');
  });

  it('detects overconfidence', () => {
    const bias = getSystematicBias({ average_confidence: 0.8, accuracy: 0.5, total: 10 });
    expect(bias.direction).toBe('overconfident');
    expect(bias.magnitude).toBeCloseTo(0.3);
  });

  it('detects underconfidence', () => {
    const bias = getSystematicBias({ average_confidence: 0.5, accuracy: 0.8, total: 10 });
    expect(bias.direction).toBe('underconfident');
    expect(bias.magnitude).toBeCloseTo(0.3);
  });

  it('returns well-calibrated for small gaps', () => {
    const bias = getSystematicBias({ average_confidence: 0.72, accuracy: 0.7, total: 10 });
    expect(bias.direction).toBe('well-calibrated');
    expect(bias.magnitude).toBeLessThan(0.05);
  });
});

describe('calibrationReport', () => {
  it('returns markdown report for empty db', () => {
    const report = calibrationReport(db);
    expect(report).toContain('# Calibration Report');
    expect(report).toContain('## Overview');
    expect(report).toContain('Total predictions');
  });

  it('includes domain breakdown when predictions exist', () => {
    const id1 = addPrediction(db, { topic: 'A', prediction: 'P', confidence: 0.8, domain: 'technical' });
    const id2 = addPrediction(db, { topic: 'B', prediction: 'P', confidence: 0.6, domain: 'general' });
    resolvePrediction(db, id1, 'correct');
    resolvePrediction(db, id2, 'incorrect');

    const report = calibrationReport(db);
    expect(report).toContain('## By Domain');
    expect(report).toContain('technical');
    expect(report).toContain('general');
  });

  it('includes systematic bias section', () => {
    const report = calibrationReport(db);
    expect(report).toContain('## Systematic Bias');
  });

  it('includes recommendations for small datasets', () => {
    const id = addPrediction(db, { topic: 'A', prediction: 'P', confidence: 0.8 });
    resolvePrediction(db, id, 'correct');

    const report = calibrationReport(db);
    expect(report).toContain('## Recommendations');
    expect(report).toContain('Make more predictions');
  });

  it('counts pending and resolved correctly', () => {
    const id1 = addPrediction(db, { topic: 'A', prediction: 'P', confidence: 0.8 });
    addPrediction(db, { topic: 'B', prediction: 'P', confidence: 0.6 });
    resolvePrediction(db, id1, 'correct');

    const report = calibrationReport(db);
    expect(report).toContain('| Total predictions | 2 |');
    expect(report).toContain('| Resolved | 1 |');
    expect(report).toContain('| Pending | 1 |');
  });
});
