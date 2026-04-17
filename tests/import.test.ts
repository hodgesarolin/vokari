import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  initKnowledge,
  addKnowledge,
  getKnowledgeByKey,
  getKnowledgeStats,
  importAllToKnowledge,
  searchKnowledge,
} from '../src/knowledge.js';
import { initDb } from '../src/db.js';
import { initBeliefs, addBelief } from '../src/beliefs.js';
import { initPositions, addPosition } from '../src/positions.js';
import { initPredictions, addPrediction } from '../src/predictions.js';
import { addCorrection } from '../src/corrections.js';

/** Helper to get count by type from stats.byType array */
function countByType(stats: { byType: { type: string; count: number }[] }, type: string): number {
  const entry = stats.byType.find(e => e.type === type);
  return entry?.count ?? 0;
}

describe('Import to Knowledge Store', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
    initBeliefs(db);
    initPositions(db);
    initPredictions(db);
    initKnowledge(db);
  });

  describe('importAllToKnowledge — from legacy tables', () => {
    it('imports beliefs to knowledge store', () => {
      addBelief(db, {
        statement: 'Daniel prefers concise responses',
        category: 'user',
        confidence: 0.9,
        source: 'conversation',
        evidence: ['conversation Feb 2'],
        tags: ['preferences', 'communication'],
      });

      const result = importAllToKnowledge(db);
      expect(result.beliefs).toBe(1);

      // Find it in knowledge store
      const stats = getKnowledgeStats(db);
      expect(countByType(stats, 'belief')).toBe(1);
    });

    it('imports corrections to knowledge store', () => {
      addCorrection(db, {
        type: 'fact',
        content: "Kim's income is ~$120K/yr",
        root_cause: 'wrong assumption',
        source: 'Daniel',
        permanence: 'never',
      });

      const result = importAllToKnowledge(db);
      expect(result.corrections).toBe(1);

      const stats = getKnowledgeStats(db);
      expect(countByType(stats, 'correction')).toBe(1);
    });

    it('imports positions to knowledge store', () => {
      addPosition(db, {
        topic: 'Brain design',
        position: 'Thinking partnership is primary value',
        confidence: 0.7,
        evidence: ['transcript analysis'],
        reasoning: 'Evidence-based',
      });

      const result = importAllToKnowledge(db);
      expect(result.positions).toBe(1);

      const stats = getKnowledgeStats(db);
      expect(countByType(stats, 'position')).toBe(1);
    });

    it('imports predictions to knowledge store', () => {
      addPrediction(db, {
        topic: 'SCOTUS',
        prediction: 'Govt loses IEEPA',
        confidence: 0.7,
        reasoning: 'Constitutional analysis',
        resolution_criteria: 'SCOTUS ruling',
        domain: 'political',
        check_date: '2026-02-20',
      });

      const result = importAllToKnowledge(db);
      expect(result.predictions).toBe(1);

      const stats = getKnowledgeStats(db);
      expect(countByType(stats, 'prediction')).toBe(1);
    });

    it('is idempotent — re-importing skips existing rows', () => {
      addBelief(db, {
        statement: 'Test belief for idempotency',
        category: 'user',
        confidence: 0.8,
      });

      const result1 = importAllToKnowledge(db);
      expect(result1.beliefs).toBe(1);

      // Second import should skip
      const result2 = importAllToKnowledge(db);
      expect(result2.beliefs).toBe(0);

      // Still just 1 belief row in knowledge
      const stats = getKnowledgeStats(db);
      expect(countByType(stats, 'belief')).toBe(1);
    });

    it('imports all types in a single call', () => {
      addBelief(db, { statement: 'A belief', category: 'world', confidence: 0.5 });
      addCorrection(db, { type: 'pattern', content: 'A correction' });
      addPosition(db, { topic: 'Topic', position: 'A position', confidence: 0.6 });
      addPrediction(db, { topic: 'Test', prediction: 'A prediction', confidence: 0.5 });

      const result = importAllToKnowledge(db);
      expect(result.beliefs).toBe(1);
      expect(result.corrections).toBe(1);
      expect(result.positions).toBe(1);
      expect(result.predictions).toBe(1);

      const stats = getKnowledgeStats(db);
      expect(stats.total).toBe(4);
    });
  });

  describe('cross-source search', () => {
    it('searches across imported beliefs and corrections', () => {
      addBelief(db, {
        statement: 'Kim earns approximately $120K per year at the veterinary practice',
        category: 'user',
        confidence: 0.95,
        source: 'Daniel',
        tags: ['finances'],
      });

      addCorrection(db, {
        type: 'fact',
        content: "Kim hourly rate is approximately $105 per hour, NOT $96 or $115",
        root_cause: 'miscalculation',
        source: 'Daniel',
        permanence: 'never',
      });

      importAllToKnowledge(db);

      // Search for Kim should find both
      const results = searchKnowledge(db, 'Kim');
      expect(results.length).toBe(2);

      const types = results.map(r => r.type);
      expect(types).toContain('belief');
      expect(types).toContain('correction');
    });
  });

  describe('context file import (manual)', () => {
    it('supports adding context files as knowledge', () => {
      addKnowledge(db, {
        type: 'context',
        key: 'family',
        content: '# Family\n\nWife: Kim (DVM)\nKids: Lily (6), Ben (4), Rowan (19mo)',
        metadata: {
          source_file: 'family.md',
          imported_from: 'context_files',
        },
        mutable: false,
      });

      addKnowledge(db, {
        type: 'handoff',
        key: 'interactive-context',
        content: '# Interactive Session Context\n\nLast active: Feb 20',
        metadata: {
          source_file: 'interactive-context.md',
          imported_from: 'context_files',
        },
        mutable: true,
      });

      const family = getKnowledgeByKey(db, 'context', 'family');
      expect(family).toBeDefined();
      expect(family!.content).toContain('Kim (DVM)');

      const handoff = getKnowledgeByKey(db, 'handoff', 'interactive-context');
      expect(handoff).toBeDefined();
      expect(handoff!.mutable).toBe(true);
    });
  });
});
