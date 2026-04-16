/**
 * Concurrent access tests for Vokari.
 *
 * Uses file-based DB (not :memory:) to test that two connections
 * can read and write simultaneously without corruption.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initDb, addCorrection, listCorrections, getStats } from '../src/db.js';
import { initBeliefs, addBelief, listBeliefs, getBeliefStats } from '../src/beliefs.js';
import { initPredictions, addPrediction, listPredictions, resolvePrediction } from '../src/predictions.js';
import { initKnowledge, addKnowledge, searchKnowledge } from '../src/knowledge.js';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'vokari-test-'));
  dbPath = join(tmpDir, 'test.db');
  // Initialize schema with first connection
  const db = initDb(dbPath);
  initBeliefs(db);
  initPredictions(db);
  initKnowledge(db);
  db.close();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('concurrent file-based access', () => {
  it('two connections can write corrections simultaneously', () => {
    const db1 = new Database(dbPath);
    db1.pragma('journal_mode = WAL');
    const db2 = new Database(dbPath);
    db2.pragma('journal_mode = WAL');

    // Write from connection 1
    const id1 = addCorrection(db1, { type: 'fact', content: 'From connection 1' });
    // Write from connection 2
    const id2 = addCorrection(db2, { type: 'pattern', content: 'From connection 2' });

    // Both should be visible from either connection
    const fromDb1 = listCorrections(db1);
    const fromDb2 = listCorrections(db2);
    expect(fromDb1).toHaveLength(2);
    expect(fromDb2).toHaveLength(2);
    expect(fromDb1.map(c => c.id).sort()).toEqual(fromDb2.map(c => c.id).sort());

    db1.close();
    db2.close();
  });

  it('two connections can write beliefs simultaneously', () => {
    const db1 = new Database(dbPath);
    db1.pragma('journal_mode = WAL');
    const db2 = new Database(dbPath);
    db2.pragma('journal_mode = WAL');

    addBelief(db1, { statement: 'Belief from conn 1', category: 'world', confidence: 0.8 });
    addBelief(db2, { statement: 'Belief from conn 2', category: 'user', confidence: 0.7 });

    const stats1 = getBeliefStats(db1);
    const stats2 = getBeliefStats(db2);
    expect(stats1.total).toBe(2);
    expect(stats2.total).toBe(2);

    db1.close();
    db2.close();
  });

  it('writer does not block reader', () => {
    const writer = new Database(dbPath);
    writer.pragma('journal_mode = WAL');
    const reader = new Database(dbPath);
    reader.pragma('journal_mode = WAL');

    // Seed some data
    addCorrection(writer, { type: 'fact', content: 'Initial data' });

    // Reader sees initial data
    let corrections = listCorrections(reader);
    expect(corrections).toHaveLength(1);

    // Writer adds more
    addCorrection(writer, { type: 'pattern', content: 'Added later' });

    // Reader sees updated data
    corrections = listCorrections(reader);
    expect(corrections).toHaveLength(2);

    writer.close();
    reader.close();
  });

  it('interleaved reads and writes across connections', () => {
    const db1 = new Database(dbPath);
    db1.pragma('journal_mode = WAL');
    const db2 = new Database(dbPath);
    db2.pragma('journal_mode = WAL');

    // Interleave: write1, read2, write2, read1
    addCorrection(db1, { type: 'fact', content: 'Step 1 from db1' });
    expect(listCorrections(db2)).toHaveLength(1);

    addCorrection(db2, { type: 'pattern', content: 'Step 2 from db2' });
    expect(listCorrections(db1)).toHaveLength(2);

    addBelief(db1, { statement: 'Belief step 3', category: 'world' });
    expect(getBeliefStats(db2).total).toBe(1);

    addBelief(db2, { statement: 'Belief step 4', category: 'self' });
    expect(getBeliefStats(db1).total).toBe(2);

    db1.close();
    db2.close();
  });

  it('predictions can be written and resolved from different connections', () => {
    const db1 = new Database(dbPath);
    db1.pragma('journal_mode = WAL');
    const db2 = new Database(dbPath);
    db2.pragma('journal_mode = WAL');

    const pastDate = new Date(Date.now() - 86400000).toISOString();

    // Write prediction from db1
    const id = addPrediction(db1, {
      topic: 'concurrent-test',
      prediction: 'This will work',
      confidence: 0.9,
      check_date: pastDate,
    });

    // Resolve from db2
    resolvePrediction(db2, id, 'correct');

    // Verify from db1
    const all = listPredictions(db1, { resolved: true });
    expect(all).toHaveLength(1);
    expect(all[0].outcome).toBe('correct');

    db1.close();
    db2.close();
  });

  it('knowledge FTS works across connections', () => {
    const db1 = new Database(dbPath);
    db1.pragma('journal_mode = WAL');
    const db2 = new Database(dbPath);
    db2.pragma('journal_mode = WAL');

    addKnowledge(db1, {
      type: 'research',
      key: 'rotator-cuff',
      content: 'Rotator cuff surgery recovery takes 5-6 months',
    });

    // Search from different connection
    const results = searchKnowledge(db2, 'rotator cuff');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain('Rotator cuff');

    db1.close();
    db2.close();
  });

  it('stats are consistent across connections after writes', () => {
    const db1 = new Database(dbPath);
    db1.pragma('journal_mode = WAL');
    const db2 = new Database(dbPath);
    db2.pragma('journal_mode = WAL');

    addCorrection(db1, { type: 'policy', content: 'P1', permanence: 'never' });
    addCorrection(db2, { type: 'fact', content: 'F1', permanence: 'never' });
    addCorrection(db1, { type: 'pattern', content: 'Pa1', permanence: 'graduable' });

    const stats1 = getStats(db1);
    const stats2 = getStats(db2);

    expect(stats1.total).toBe(3);
    expect(stats2.total).toBe(3);
    expect(stats1.by_type.policy).toBe(1);
    expect(stats2.by_type.fact).toBe(1);

    db1.close();
    db2.close();
  });
});
