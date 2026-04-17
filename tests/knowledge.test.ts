import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  initKnowledge,
  addKnowledge,
  getKnowledge,
  getKnowledgeByKey,
  listKnowledge,
  updateKnowledge,
  upsertKnowledge,
  deleteKnowledge,
  deleteKnowledgeByType,
  searchKnowledge,
  getKnowledgeStats,
  importBeliefsToKnowledge,
  importCorrectionsToKnowledge,
  importPositionsToKnowledge,
  importPredictionsToKnowledge,
  importAllToKnowledge,
  listKnowledgeInternal,
  MetadataFilter,
} from '../src/knowledge.js';
import type { KnowledgeType } from '../src/knowledge.js';
import { initDb } from '../src/db.js';
import { addBelief, initBeliefs } from '../src/beliefs.js';
import { addCorrection } from '../src/corrections.js';
import { addPosition, initPositions } from '../src/positions.js';
import { addPrediction, initPredictions } from '../src/predictions.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initKnowledge(db);
});

// ── Schema Initialization ──

describe('initKnowledge', () => {
  it('creates the knowledge table', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge'"
    ).all();
    expect(tables).toHaveLength(1);
  });

  it('creates the FTS5 virtual table', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_fts'"
    ).all();
    expect(tables).toHaveLength(1);
  });

  it('creates insert/delete/update triggers', () => {
    const triggers = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'knowledge_%'"
    ).all() as { name: string }[];
    const names = triggers.map(t => t.name).sort();
    expect(names).toEqual(['knowledge_ad', 'knowledge_ai', 'knowledge_au']);
  });

  it('is idempotent', () => {
    // calling again should not throw
    initKnowledge(db);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge'"
    ).all();
    expect(tables).toHaveLength(1);
  });
});

// ── addKnowledge ──

describe('addKnowledge', () => {
  it('returns a UUID', () => {
    const id = addKnowledge(db, { type: 'belief', content: 'Test belief' });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('stores all fields', () => {
    const id = addKnowledge(db, {
      type: 'correction',
      key: 'correction-fact-1',
      content: 'Kim earns $105/hr',
      metadata: { correction_type: 'fact', permanence: 'never' },
      mutable: false,
    });
    const k = getKnowledge(db, id);
    expect(k).toBeDefined();
    expect(k!.type).toBe('correction');
    expect(k!.key).toBe('correction-fact-1');
    expect(k!.content).toBe('Kim earns $105/hr');
    expect(k!.metadata).toEqual({ correction_type: 'fact', permanence: 'never' });
    expect(k!.mutable).toBe(false);
  });

  it('defaults metadata to empty object', () => {
    const id = addKnowledge(db, { type: 'belief', content: 'Test' });
    const k = getKnowledge(db, id);
    expect(k!.metadata).toEqual({});
  });

  it('defaults mutable to false', () => {
    const id = addKnowledge(db, { type: 'belief', content: 'Test' });
    const k = getKnowledge(db, id);
    expect(k!.mutable).toBe(false);
  });

  it('allows mutable to be true', () => {
    const id = addKnowledge(db, { type: 'handoff', content: 'Test', mutable: true });
    const k = getKnowledge(db, id);
    expect(k!.mutable).toBe(true);
  });
});

// ── getKnowledgeByKey ──

describe('getKnowledgeByKey', () => {
  it('retrieves by type + key', () => {
    addKnowledge(db, { type: 'handoff', key: 'interactive-context', content: 'Session state' });
    const k = getKnowledgeByKey(db, 'handoff', 'interactive-context');
    expect(k).toBeDefined();
    expect(k!.content).toBe('Session state');
  });

  it('returns undefined for non-existent key', () => {
    const k = getKnowledgeByKey(db, 'handoff', 'nonexistent');
    expect(k).toBeUndefined();
  });

  it('differentiates by type', () => {
    addKnowledge(db, { type: 'handoff', key: 'same-key', content: 'Handoff content' });
    addKnowledge(db, { type: 'context', key: 'same-key', content: 'Context content' });

    const h = getKnowledgeByKey(db, 'handoff', 'same-key');
    const c = getKnowledgeByKey(db, 'context', 'same-key');
    expect(h!.content).toBe('Handoff content');
    expect(c!.content).toBe('Context content');
  });
});

// ── listKnowledge ──

describe('listKnowledge', () => {
  beforeEach(() => {
    addKnowledge(db, { type: 'belief', content: 'Belief 1' });
    addKnowledge(db, { type: 'correction', content: 'Correction 1' });
    addKnowledge(db, { type: 'handoff', content: 'Handoff 1', mutable: true });
    addKnowledge(db, { type: 'position', content: 'Position 1' });
  });

  it('lists all knowledge', () => {
    const all = listKnowledge(db);
    expect(all).toHaveLength(4);
  });

  it('filters by type', () => {
    const beliefs = listKnowledge(db, { type: 'belief' });
    expect(beliefs).toHaveLength(1);
    expect(beliefs[0].type).toBe('belief');
  });

  it('filters by multiple types', () => {
    const items = listKnowledge(db, { types: ['belief', 'correction'] });
    expect(items).toHaveLength(2);
  });

  it('filters by mutable', () => {
    const mutable = listKnowledge(db, { mutable: true });
    expect(mutable).toHaveLength(1);
    expect(mutable[0].type).toBe('handoff');
  });

  it('respects limit', () => {
    const items = listKnowledge(db, { limit: 2 });
    expect(items).toHaveLength(2);
  });

  it('filters by metadata', () => {
    addKnowledge(db, {
      type: 'correction',
      content: 'Policy correction',
      metadata: { correction_type: 'policy', permanence: 'never' },
    });

    const policies = listKnowledgeInternal(db, {
      type: 'correction',
      metadataFilter: MetadataFilter('correction_type_policy'),
    });
    expect(policies).toHaveLength(1);
    expect(policies[0].content).toBe('Policy correction');
  });
});

// ── updateKnowledge ──

describe('updateKnowledge', () => {
  it('updates content', () => {
    const id = addKnowledge(db, { type: 'belief', content: 'Old content' });
    const updated = updateKnowledge(db, id, { content: 'New content' });
    expect(updated!.content).toBe('New content');
  });

  it('updates metadata', () => {
    const id = addKnowledge(db, {
      type: 'belief',
      content: 'Test',
      metadata: { confidence: 0.5 },
    });
    const updated = updateKnowledge(db, id, { metadata: { confidence: 0.9 } });
    expect(updated!.metadata).toEqual({ confidence: 0.9 });
  });

  it('updates updated_at timestamp', () => {
    // Insert with a fixed past timestamp to guarantee difference
    const id = addKnowledge(db, { type: 'belief', content: 'Test' });
    db.prepare("UPDATE knowledge SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(id);
    const before = getKnowledge(db, id)!.updated_at;
    const updated = updateKnowledge(db, id, { content: 'Updated' });
    expect(updated!.updated_at).not.toBe(before);
  });

  it('returns undefined for non-existent id', () => {
    const result = updateKnowledge(db, 'nonexistent', { content: 'Test' });
    expect(result).toBeUndefined();
  });
});

// ── upsertKnowledge ──

describe('upsertKnowledge', () => {
  it('creates new row when no match exists', () => {
    const id = upsertKnowledge(db, {
      type: 'handoff',
      key: 'interactive-context',
      content: 'First version',
    });
    const k = getKnowledge(db, id);
    expect(k!.content).toBe('First version');
  });

  it('overwrites existing row on type+key match', () => {
    const id1 = upsertKnowledge(db, {
      type: 'handoff',
      key: 'interactive-context',
      content: 'First version',
    });
    const id2 = upsertKnowledge(db, {
      type: 'handoff',
      key: 'interactive-context',
      content: 'Second version',
      metadata: { updated: true },
    });
    // Same ID — overwrite, not duplicate
    expect(id2).toBe(id1);
    const k = getKnowledge(db, id2);
    expect(k!.content).toBe('Second version');
    expect(k!.metadata).toEqual({ updated: true });
  });

  it('defaults handoff type to mutable', () => {
    const id = upsertKnowledge(db, {
      type: 'handoff',
      key: 'test',
      content: 'Test',
    });
    const k = getKnowledge(db, id);
    expect(k!.mutable).toBe(true);
  });

  it('defaults context type to mutable', () => {
    const id = upsertKnowledge(db, {
      type: 'context',
      key: 'identity',
      content: 'Brain identity',
    });
    const k = getKnowledge(db, id);
    expect(k!.mutable).toBe(true);
  });

  it('does not default other types to mutable', () => {
    const id = upsertKnowledge(db, {
      type: 'research',
      key: 'test-research',
      content: 'Research content',
    });
    const k = getKnowledge(db, id);
    expect(k!.mutable).toBe(false);
  });

  it('handles rapid successive upserts', () => {
    for (let i = 0; i < 10; i++) {
      upsertKnowledge(db, {
        type: 'handoff',
        key: 'rapid-test',
        content: `Version ${i}`,
      });
    }
    const k = getKnowledgeByKey(db, 'handoff', 'rapid-test');
    expect(k!.content).toBe('Version 9');
    // Should still be just one row
    const count = (db.prepare(
      "SELECT COUNT(*) as c FROM knowledge WHERE type = 'handoff' AND key = 'rapid-test'"
    ).get() as { c: number }).c;
    expect(count).toBe(1);
  });
});

// ── deleteKnowledge ──

describe('deleteKnowledge', () => {
  it('deletes by id', () => {
    const id = addKnowledge(db, { type: 'belief', content: 'Test' });
    expect(deleteKnowledge(db, id)).toBe(true);
    expect(getKnowledge(db, id)).toBeUndefined();
  });

  it('returns false for non-existent id', () => {
    expect(deleteKnowledge(db, 'nonexistent')).toBe(false);
  });
});

describe('deleteKnowledgeByType', () => {
  it('deletes all of a type', () => {
    addKnowledge(db, { type: 'belief', content: 'B1' });
    addKnowledge(db, { type: 'belief', content: 'B2' });
    addKnowledge(db, { type: 'correction', content: 'C1' });

    const deleted = deleteKnowledgeByType(db, 'belief');
    expect(deleted).toBe(2);
    expect(listKnowledge(db, { type: 'belief' })).toHaveLength(0);
    expect(listKnowledge(db, { type: 'correction' })).toHaveLength(1);
  });

  it('deletes by type and key', () => {
    addKnowledge(db, { type: 'handoff', key: 'keep', content: 'Keep this' });
    addKnowledge(db, { type: 'handoff', key: 'delete', content: 'Delete this' });

    const deleted = deleteKnowledgeByType(db, 'handoff', 'delete');
    expect(deleted).toBe(1);
    expect(getKnowledgeByKey(db, 'handoff', 'keep')).toBeDefined();
    expect(getKnowledgeByKey(db, 'handoff', 'delete')).toBeUndefined();
  });
});

// ── FTS5 Search ──

describe('searchKnowledge', () => {
  beforeEach(() => {
    addKnowledge(db, {
      type: 'belief',
      content: 'Kim earns approximately $105 per hour as a veterinarian',
      metadata: { category: 'user', confidence: 0.95 },
    });
    addKnowledge(db, {
      type: 'correction',
      content: 'Always verify day of week before stating dates',
      metadata: { correction_type: 'pattern' },
    });
    addKnowledge(db, {
      type: 'research',
      content: 'SCOTUS ruled 6-3 striking down IEEPA tariff authority',
      metadata: { source_file: 'scotus-ieepa.md' },
    });
    addKnowledge(db, {
      type: 'position',
      content: 'Context quality has higher marginal ROI than model quality',
      metadata: { confidence: 0.7, status: 'held' },
    });
  });

  it('finds content by keyword', () => {
    const results = searchKnowledge(db, 'veterinarian');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain('veterinarian');
  });

  it('returns snippet', () => {
    const results = searchKnowledge(db, 'veterinarian');
    expect(results[0].snippet).toBeDefined();
    expect(results[0].snippet.length).toBeGreaterThan(0);
  });

  it('filters by type', () => {
    const results = searchKnowledge(db, 'quality', { type: 'position' });
    expect(results.length).toBe(1);
    expect(results[0].type).toBe('position');
  });

  it('filters by multiple types', () => {
    // Use a term that appears in the correction content
    const results = searchKnowledge(db, 'verify', {
      types: ['correction', 'research'],
    });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(['correction', 'research']).toContain(r.type);
    }
  });

  it('respects limit', () => {
    // Add more content
    for (let i = 0; i < 20; i++) {
      addKnowledge(db, { type: 'belief', content: `Test belief about data ${i}` });
    }
    const results = searchKnowledge(db, 'data', { limit: 5 });
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it('returns empty for empty query', () => {
    const results = searchKnowledge(db, '');
    expect(results).toHaveLength(0);
  });

  it('handles special characters in query', () => {
    const results = searchKnowledge(db, "Kim's $105/hr rate");
    // Should not throw — special chars are sanitized
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  it('searches across types by default', () => {
    // Use a single term that's present in our test data
    const results = searchKnowledge(db, 'veterinarian');
    expect(results.length).toBeGreaterThan(0);
    // Without type filter, should return from any matching type
    expect(results[0].type).toBe('belief');
  });
});

// ── Statistics ──

describe('getKnowledgeStats', () => {
  it('returns correct counts', () => {
    addKnowledge(db, { type: 'belief', content: 'B1' });
    addKnowledge(db, { type: 'belief', content: 'B2' });
    addKnowledge(db, { type: 'correction', content: 'C1' });
    addKnowledge(db, { type: 'handoff', content: 'H1', mutable: true });

    const stats = getKnowledgeStats(db);
    expect(stats.total).toBe(4);
    expect(stats.mutableCount).toBe(1);
    expect(stats.byType).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'belief', count: 2 }),
        expect.objectContaining({ type: 'correction', count: 1 }),
        expect.objectContaining({ type: 'handoff', count: 1 }),
      ])
    );
  });

  it('returns zeros for empty db', () => {
    const stats = getKnowledgeStats(db);
    expect(stats.total).toBe(0);
    expect(stats.mutableCount).toBe(0);
    expect(stats.byType).toHaveLength(0);
  });
});

// ── Migration: Beliefs ──

describe('importBeliefsToKnowledge', () => {
  beforeEach(() => {
    // Set up legacy beliefs table
    initBeliefs(db);
    addBelief(db, {
      statement: 'Daniel is 40 years old',
      category: 'user',
      confidence: 0.99,
      evidence: ['Confirmed Feb 19'],
      tags: ['age', 'personal'],
    });
    addBelief(db, {
      statement: 'PS 28 is the school',
      category: 'user',
      confidence: 0.95,
      tags: ['school', 'family'],
    });
  });

  it('imports all beliefs', () => {
    const count = importBeliefsToKnowledge(db);
    expect(count).toBe(2);
  });

  it('preserves content as statement', () => {
    importBeliefsToKnowledge(db);
    const beliefs = listKnowledge(db, { type: 'belief' });
    expect(beliefs.length).toBe(2);
    const found = beliefs.find(b => b.content === 'Daniel is 40 years old');
    expect(found).toBeDefined();
  });

  it('preserves metadata', () => {
    importBeliefsToKnowledge(db);
    const beliefs = listKnowledge(db, { type: 'belief' });
    const age = beliefs.find(b => b.content.includes('40'));
    expect(age!.metadata.category).toBe('user');
    expect(age!.metadata.confidence).toBe(0.99);
    expect(age!.metadata.evidence).toEqual(['Confirmed Feb 19']);
    expect(age!.metadata.tags).toEqual(['age', 'personal']);
  });

  it('is idempotent (INSERT OR IGNORE)', () => {
    importBeliefsToKnowledge(db);
    importBeliefsToKnowledge(db);
    const beliefs = listKnowledge(db, { type: 'belief' });
    expect(beliefs.length).toBe(2);
  });

  it('makes imported beliefs searchable', () => {
    importBeliefsToKnowledge(db);
    const results = searchKnowledge(db, 'school', { type: 'belief' });
    expect(results.length).toBeGreaterThan(0);
  });
});

// ── Migration: Corrections ──

describe('importCorrectionsToKnowledge', () => {
  beforeEach(() => {
    // initDb creates corrections table
    const tempDb = initDb(':memory:');
    // We need to re-create the corrections table on our db
    db.exec(`
      CREATE TABLE IF NOT EXISTS corrections (
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
      )
    `);
    addCorrection(db, {
      type: 'fact',
      content: "Kim's income is $105/hr",
      permanence: 'never',
    });
    addCorrection(db, {
      type: 'pattern',
      content: 'Always verify day of week',
      permanence: 'graduable',
      root_cause: 'Inferred from timestamps',
    });
  });

  it('imports all corrections', () => {
    const count = importCorrectionsToKnowledge(db);
    expect(count).toBe(2);
  });

  it('preserves correction metadata', () => {
    importCorrectionsToKnowledge(db);
    const corrections = listKnowledge(db, { type: 'correction' });
    const fact = corrections.find(c => c.content.includes('$105'));
    expect(fact!.metadata.correction_type).toBe('fact');
    expect(fact!.metadata.permanence).toBe('never');
  });

  it('makes imported corrections searchable', () => {
    importCorrectionsToKnowledge(db);
    const results = searchKnowledge(db, 'verify day week');
    expect(results.length).toBeGreaterThan(0);
  });
});

// ── Migration: Positions ──

describe('importPositionsToKnowledge', () => {
  beforeEach(() => {
    initPositions(db);
    addPosition(db, {
      topic: 'Context-first thesis',
      position: 'Context quality has higher marginal ROI than model quality',
      confidence: 0.7,
      evidence: ['METR study', 'Sprint result'],
    });
  });

  it('imports positions', () => {
    const count = importPositionsToKnowledge(db);
    expect(count).toBe(1);
  });

  it('combines topic and position in content', () => {
    importPositionsToKnowledge(db);
    const positions = listKnowledge(db, { type: 'position' });
    expect(positions[0].content).toContain('Context-first thesis');
    expect(positions[0].content).toContain('marginal ROI');
  });

  it('preserves position metadata', () => {
    importPositionsToKnowledge(db);
    const positions = listKnowledge(db, { type: 'position' });
    expect(positions[0].metadata.confidence).toBe(0.7);
    expect(positions[0].metadata.evidence).toEqual(['METR study', 'Sprint result']);
  });
});

// ── Migration: Predictions ──

describe('importPredictionsToKnowledge', () => {
  beforeEach(() => {
    initPredictions(db);
    addPrediction(db, {
      topic: 'SCOTUS IEEPA',
      prediction: 'Government loses 6-3',
      confidence: 0.7,
      domain: 'political',
      check_date: '2026-02-28',
    });
  });

  it('imports predictions', () => {
    const count = importPredictionsToKnowledge(db);
    expect(count).toBe(1);
  });

  it('preserves prediction metadata', () => {
    importPredictionsToKnowledge(db);
    const predictions = listKnowledge(db, { type: 'prediction' });
    expect(predictions[0].metadata.confidence).toBe(0.7);
    expect(predictions[0].metadata.domain).toBe('political');
    expect(predictions[0].metadata.check_date).toBe('2026-02-28');
  });
});

// ── Migration: All ──

describe('importAllToKnowledge', () => {
  beforeEach(() => {
    // Create all legacy tables
    db.exec(`
      CREATE TABLE IF NOT EXISTS corrections (
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
      )
    `);
    initBeliefs(db);
    initPositions(db);
    initPredictions(db);

    // Add test data
    addBelief(db, { statement: 'Test belief', category: 'user' });
    addCorrection(db, { type: 'fact', content: 'Test correction' });
    addPosition(db, { topic: 'Test', position: 'Test position' });
    addPrediction(db, { topic: 'Test', prediction: 'Test prediction', confidence: 0.5 });
  });

  it('imports all types', () => {
    const result = importAllToKnowledge(db);
    expect(result.beliefs).toBe(1);
    expect(result.corrections).toBe(1);
    expect(result.positions).toBe(1);
    expect(result.predictions).toBe(1);
    expect(result.total).toBe(4);
  });

  it('all imported rows are searchable', () => {
    importAllToKnowledge(db);
    expect(searchKnowledge(db, 'belief').length).toBeGreaterThan(0);
    expect(searchKnowledge(db, 'correction').length).toBeGreaterThan(0);
    expect(searchKnowledge(db, 'position').length).toBeGreaterThan(0);
    expect(searchKnowledge(db, 'prediction').length).toBeGreaterThan(0);
  });
});

// ── FTS5 Sync ──

describe('FTS5 sync', () => {
  it('indexes content on insert', () => {
    addKnowledge(db, { type: 'belief', content: 'Unique searchable zebra content' });
    const results = searchKnowledge(db, 'zebra');
    expect(results.length).toBe(1);
  });

  it('removes from FTS on delete', () => {
    const id = addKnowledge(db, { type: 'belief', content: 'Deletable flamingo content' });
    deleteKnowledge(db, id);
    const results = searchKnowledge(db, 'flamingo');
    expect(results.length).toBe(0);
  });

  it('updates FTS on update', () => {
    const id = addKnowledge(db, { type: 'belief', content: 'Old platypus content' });
    updateKnowledge(db, id, { content: 'New pangolin content' });

    expect(searchKnowledge(db, 'platypus').length).toBe(0);
    expect(searchKnowledge(db, 'pangolin').length).toBe(1);
  });

  it('updates FTS on upsert overwrite', () => {
    upsertKnowledge(db, {
      type: 'handoff',
      key: 'test-fts-upsert',
      content: 'Original narwhal content',
    });
    expect(searchKnowledge(db, 'narwhal').length).toBe(1);

    upsertKnowledge(db, {
      type: 'handoff',
      key: 'test-fts-upsert',
      content: 'Updated armadillo content',
    });
    expect(searchKnowledge(db, 'narwhal').length).toBe(0);
    expect(searchKnowledge(db, 'armadillo').length).toBe(1);
  });
});

// ── Edge Cases ──

describe('edge cases', () => {
  it('handles large content', () => {
    const largeContent = 'word '.repeat(10000);
    const id = addKnowledge(db, { type: 'research', content: largeContent });
    const k = getKnowledge(db, id);
    expect(k!.content.length).toBe(largeContent.length);
  });

  it('handles complex metadata', () => {
    const metadata = {
      nested: { deep: { value: 42 } },
      array: [1, 'two', { three: true }],
      nullVal: null,
      emptyStr: '',
    };
    const id = addKnowledge(db, { type: 'belief', content: 'Test', metadata });
    const k = getKnowledge(db, id);
    expect(k!.metadata).toEqual(metadata);
  });

  it('enforces unique type+key constraint', () => {
    addKnowledge(db, { type: 'handoff', key: 'unique-key', content: 'First' });
    expect(() => {
      addKnowledge(db, { type: 'handoff', key: 'unique-key', content: 'Duplicate' });
    }).toThrow();
  });

  it('allows same key with different types', () => {
    addKnowledge(db, { type: 'handoff', key: 'shared-key', content: 'Handoff' });
    addKnowledge(db, { type: 'context', key: 'shared-key', content: 'Context' });
    const all = listKnowledge(db);
    expect(all).toHaveLength(2);
  });

  it('allows null key (multiple rows without key)', () => {
    addKnowledge(db, { type: 'belief', content: 'Belief 1' });
    addKnowledge(db, { type: 'belief', content: 'Belief 2' });
    addKnowledge(db, { type: 'belief', content: 'Belief 3' });
    const beliefs = listKnowledge(db, { type: 'belief' });
    expect(beliefs).toHaveLength(3);
  });
});
