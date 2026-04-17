import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDb } from '../src/db.js';
import { addCorrection } from '../src/corrections.js';
import { addBelief } from '../src/beliefs.js';
import { addPosition } from '../src/positions.js';
import { addPrediction } from '../src/predictions.js';
import { initKnowledge, addKnowledge, upsertKnowledge, searchKnowledge } from '../src/knowledge.js';
import { assembleContext } from '../src/compiler.js';

let db: Database.Database;

beforeEach(() => {
  db = initDb(':memory:');
  initKnowledge(db);
});

// ── Basic Assembly ──

describe('assembleContext', () => {
  it('returns a context string', () => {
    addCorrection(db, { type: 'policy', content: 'No work stuff', permanence: 'never' });
    const result = assembleContext(db, { budget: 50000 });
    expect(result.context).toBeTruthy();
    expect(result.context.length).toBeGreaterThan(0);
  });

  it('returns breakdown statistics', () => {
    addCorrection(db, { type: 'fact', content: 'Test fact', permanence: 'never' });
    const result = assembleContext(db, { budget: 500 });
    expect(result.breakdown).toBeDefined();
    expect(result.breakdown.mandatory).toBeGreaterThan(0);
    expect(result.breakdown.total).toBeLessThanOrEqual(result.breakdown.budget);
    expect(result.breakdown.utilizationPct).toBeGreaterThan(0);
    expect(result.breakdown.utilizationPct).toBeLessThanOrEqual(100);
  });

  it('never exceeds budget', () => {
    addCorrection(db, { type: 'policy', content: 'A very important correction that should be included', permanence: 'never' });
    addCorrection(db, { type: 'fact', content: 'Another fact that takes up space', permanence: 'never' });
    addBelief(db, { statement: 'The sky is blue', category: 'world' });
    const result = assembleContext(db, { budget: 200 });
    expect(result.context.length).toBeLessThanOrEqual(200);
  });

  it('returns empty context for empty db', () => {
    const result = assembleContext(db, { budget: 50000 });
    expect(result.context.trim()).toBe('');
    expect(result.breakdown.total).toBe(0);
  });
});

// ── Corrections Layer ──

describe('corrections in context', () => {
  beforeEach(() => {
    addCorrection(db, { type: 'policy', content: 'No work stuff', permanence: 'never' });
    addCorrection(db, { type: 'fact', content: "Kim's income is $105/hr", permanence: 'never' });
    addCorrection(db, { type: 'pattern', content: 'Always verify day of week', permanence: 'graduable' });
  });

  it('includes corrections by default', () => {
    const result = assembleContext(db, { budget: 50000 });
    expect(result.context).toContain('No work stuff');
    expect(result.context).toContain("Kim's income is $105/hr");
    expect(result.context).toContain('Always verify day of week');
  });

  it('excludes corrections when include.corrections=false', () => {
    const result = assembleContext(db, {
      budget: 50000,
      include: { corrections: false },
    });
    expect(result.context).not.toContain('No work stuff');
    expect(result.context).not.toContain("Kim's income");
  });
});

// ── Beliefs Layer ──

describe('beliefs in context', () => {
  beforeEach(() => {
    addBelief(db, { statement: 'The user prefers dark mode', category: 'user', confidence: 0.9 });
    addBelief(db, { statement: 'TypeScript is the best language', category: 'world', confidence: 0.6 });
  });

  it('includes beliefs by default', () => {
    const result = assembleContext(db, { budget: 50000 });
    expect(result.context).toContain('dark mode');
    expect(result.context).toContain('TypeScript');
  });

  it('excludes beliefs when include.beliefs=false', () => {
    const result = assembleContext(db, {
      budget: 50000,
      include: { beliefs: false },
    });
    expect(result.context).not.toContain('dark mode');
    expect(result.context).not.toContain('TypeScript');
  });
});

// ── Positions Layer ──

describe('positions in context', () => {
  beforeEach(() => {
    addPosition(db, {
      topic: 'Context-first thesis',
      position: 'Context quality has higher ROI than model quality',
      confidence: 0.8,
    });
  });

  it('includes positions by default', () => {
    const result = assembleContext(db, { budget: 50000 });
    expect(result.context).toContain('Context quality has higher ROI');
  });

  it('excludes positions when include.positions=false', () => {
    const result = assembleContext(db, {
      budget: 50000,
      include: { positions: false },
    });
    expect(result.context).not.toContain('Context quality has higher ROI');
  });
});

// ── Predictions Layer ──

describe('predictions in context', () => {
  it('excludes predictions by default', () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString();
    addPrediction(db, {
      topic: 'Weather',
      prediction: 'It will rain tomorrow',
      confidence: 0.8,
      check_date: pastDate,
    });
    const result = assembleContext(db, { budget: 50000 });
    expect(result.context).not.toContain('It will rain');
  });

  it('includes predictions when include.predictions=true', () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString();
    addPrediction(db, {
      topic: 'Weather',
      prediction: 'It will rain tomorrow',
      confidence: 0.8,
      check_date: pastDate,
    });
    const result = assembleContext(db, {
      budget: 50000,
      include: { predictions: true },
    });
    expect(result.context).toContain('It will rain');
  });
});

// ── Include Flags ──

describe('include flags', () => {
  beforeEach(() => {
    addCorrection(db, { type: 'policy', content: 'Test correction', permanence: 'never' });
    addBelief(db, { statement: 'Test belief', category: 'world' });
    addPosition(db, { topic: 'Test', position: 'Test position', confidence: 0.7 });
  });

  it('all default to true except predictions', () => {
    const result = assembleContext(db, { budget: 50000 });
    expect(result.context).toContain('Test correction');
    expect(result.context).toContain('Test belief');
    expect(result.context).toContain('Test position');
  });

  it('can disable everything', () => {
    const result = assembleContext(db, {
      budget: 50000,
      include: {
        corrections: false,
        beliefs: false,
        positions: false,
        predictions: false,
        maintenance: false,
      },
    });
    expect(result.context.trim()).toBe('');
  });
});

// ── Relevance Layer ──

describe('relevance layer', () => {
  beforeEach(() => {
    addKnowledge(db, {
      type: 'research',
      key: 'research-shoulder',
      content: 'Rotator cuff surgery recovery: 5-6 months to lift toddler.',
    });
    addKnowledge(db, {
      type: 'research',
      key: 'research-scotus',
      content: 'SCOTUS IEEPA ruling struck down tariff authority 6-3.',
    });
  });

  it('adds relevant content when query is provided', () => {
    const result = assembleContext(db, {
      budget: 50000,
      query: 'shoulder surgery recovery',
    });
    expect(result.context).toContain('Rotator cuff surgery');
  });

  it('does NOT add content when no query is provided', () => {
    const result = assembleContext(db, { budget: 50000 });
    // Without a query, the relevance layer should not fill with recent content
    expect(result.breakdown.relevance).toBe(0);
  });
});

// ── Budget Management ──

describe('budget management', () => {
  beforeEach(() => {
    addCorrection(db, { type: 'policy', content: 'Important correction', permanence: 'never' });
    addBelief(db, { statement: 'Important belief', category: 'world' });
    addPosition(db, { topic: 'Test', position: 'Important position', confidence: 0.7 });
  });

  it('prioritizes corrections first', () => {
    const result = assembleContext(db, { budget: 200 });
    expect(result.context).toContain('Corrections');
    expect(result.breakdown.mandatory).toBeGreaterThan(0);
  });

  it('counts excluded items', () => {
    const result = assembleContext(db, { budget: 100 });
    expect(result.excluded).toBeGreaterThan(0);
  });

  it('utilization percentage is accurate', () => {
    const result = assembleContext(db, { budget: 50000 });
    const expectedPct = Math.round((result.context.length / 50000) * 100);
    expect(Math.abs(result.breakdown.utilizationPct - expectedPct)).toBeLessThanOrEqual(2);
  });
});

// ── Maintenance Layer ──

describe('maintenance layer', () => {
  it('returns zero maintenance items when tables are empty', () => {
    const result = assembleContext(db, { budget: 50000 });
    expect(result.maintenanceItems.total).toBe(0);
    expect(result.breakdown.maintenance).toBe(0);
  });

  it('surfaces beliefs never verified', () => {
    addBelief(db, { statement: 'Test belief for verification', category: 'world' });
    const result = assembleContext(db, { budget: 50000 });
    expect(result.maintenanceItems.beliefsNeverVerified).toBe(1);
    expect(result.maintenanceItems.total).toBeGreaterThan(0);
    expect(result.breakdown.maintenance).toBeGreaterThan(0);
    expect(result.context).toContain('never verified');
    expect(result.context).toContain('verification_tick');
  });

  it('surfaces predictions past check date', () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString();
    addPrediction(db, {
      topic: 'Test',
      prediction: 'Something will happen',
      confidence: 0.7,
      check_date: pastDate,
    });
    const result = assembleContext(db, { budget: 50000 });
    expect(result.maintenanceItems.predictionsPastDue).toBe(1);
    expect(result.context).toContain('past check date');
    expect(result.context).toContain('pending_predictions');
  });

  it('surfaces unchallenged positions', () => {
    // Insert a position that's old enough to be unchallenged
    db.prepare(`
      INSERT INTO positions (id, topic, position, confidence, status, created_at)
      VALUES ('pos1', 'Test topic', 'Test position', 0.7, 'held', datetime('now', '-60 days'))
    `).run();

    const result = assembleContext(db, { budget: 50000 });
    expect(result.maintenanceItems.positionsUnchallenged).toBe(1);
    expect(result.context).toContain('unchallenged');
  });

  it('surfaces active contradictions', () => {
    db.prepare(`
      INSERT INTO beliefs (id, statement, category, confidence, status, first_recorded, contradictions)
      VALUES ('b2', 'Challenged belief', 'world', 0.8, 'challenged', datetime('now'), '["some contradiction"]')
    `).run();

    const result = assembleContext(db, { budget: 50000 });
    expect(result.maintenanceItems.activeContradictions).toBe(1);
    expect(result.context).toContain('contradiction');
  });

  it('excludes maintenance when include.maintenance=false', () => {
    addBelief(db, { statement: 'Unverified belief', category: 'world' });
    const result = assembleContext(db, {
      budget: 50000,
      include: { maintenance: false },
    });
    expect(result.breakdown.maintenance).toBe(0);
    expect(result.context).not.toContain('Maintenance');
  });
});

// ── Headers ──

describe('headers', () => {
  beforeEach(() => {
    addCorrection(db, { type: 'policy', content: 'Test correction', permanence: 'never' });
  });

  it('includes headers by default', () => {
    const result = assembleContext(db, { budget: 50000 });
    expect(result.context).toContain('# Active Corrections');
  });

  it('content is present even with headers=false', () => {
    const result = assembleContext(db, {
      budget: 50000,
      headers: false,
    });
    // Content should still be there
    expect(result.context).toContain('Test correction');
  });
});
