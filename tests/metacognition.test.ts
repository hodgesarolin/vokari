import { describe, it, expect } from 'vitest';
import {
  analyzeCycling,
  getCyclingIntervention,
  categorizeContent,
  calculateAlignmentScore,
  analyzeAttentionBudget,
} from '../src/metacognition.js';
import type { TextEntry, AttentionCategory } from '../src/metacognition.js';

// ── Helpers ──

function makeEntry(overrides: Partial<TextEntry> & { id: string }): TextEntry {
  return {
    title: 'Default Title',
    content: 'Default content for testing.',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ── analyzeCycling ──

describe('analyzeCycling', () => {
  it('returns score 0 with no signals for fewer than 2 entries', () => {
    const entries = [makeEntry({ id: '1' })];
    const result = analyzeCycling(entries);
    expect(result.score).toBe(0);
    expect(result.signals).toEqual([]);
    expect(result.recommendation).toBeNull();
    expect(result.entriesAnalyzed).toBe(1);
  });

  it('returns score 0 for empty array', () => {
    const result = analyzeCycling([]);
    expect(result.score).toBe(0);
    expect(result.entriesAnalyzed).toBe(0);
  });

  it('detects no_external_data signal when 3+ entries lack external data', () => {
    const entries = [
      makeEntry({ id: '1', content: 'Just some internal thoughts about design' }),
      makeEntry({ id: '2', content: 'More internal rumination about architecture' }),
      makeEntry({ id: '3', content: 'Still thinking internally about patterns' }),
    ];
    const result = analyzeCycling(entries);
    const signal = result.signals.find(s => s.type === 'no_external_data');
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe('high');
    expect(signal!.description).toContain('3');
  });

  it('does not fire no_external_data when entries contain external data markers', () => {
    const entries = [
      makeEntry({ id: '1', content: 'I searched for the latest data using WebSearch' }),
      makeEntry({ id: '2', content: 'Fetched from the API response: 200 OK' }),
      makeEntry({ id: '3', content: 'According to recent findings from Sources:' }),
    ];
    const result = analyzeCycling(entries);
    const signal = result.signals.find(s => s.type === 'no_external_data');
    expect(signal).toBeUndefined();
  });

  it('does not fire no_external_data with only 2 entries lacking data', () => {
    const entries = [
      makeEntry({ id: '1', content: 'Internal musings about code' }),
      makeEntry({ id: '2', content: 'More internal thoughts about things' }),
      makeEntry({ id: '3', content: 'WebSearch found relevant results' }),
    ];
    const result = analyzeCycling(entries);
    const signal = result.signals.find(s => s.type === 'no_external_data');
    expect(signal).toBeUndefined();
  });

  it('detects topic_stagnation when 2+ topics appear in sessionsBack-1 entries', () => {
    const entries = [
      makeEntry({ id: '1', content: 'database optimization and caching strategy' }),
      makeEntry({ id: '2', content: 'database performance and caching layer' }),
      makeEntry({ id: '3', content: 'database indexing and caching warmup' }),
      makeEntry({ id: '4', content: 'database sharding and caching invalidation' }),
      makeEntry({ id: '5', content: 'database replication and caching eviction' }),
    ];
    const result = analyzeCycling(entries, { topicKeywords: ['database', 'caching'] });
    const signal = result.signals.find(s => s.type === 'topic_stagnation');
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe('medium');
  });

  it('does not fire topic_stagnation when topics are varied', () => {
    const entries = [
      makeEntry({ id: '1', content: 'database optimization patterns' }),
      makeEntry({ id: '2', content: 'frontend rendering strategies' }),
      makeEntry({ id: '3', content: 'network security protocols' }),
    ];
    const result = analyzeCycling(entries, { topicKeywords: ['database', 'frontend', 'network'] });
    const signal = result.signals.find(s => s.type === 'topic_stagnation');
    expect(signal).toBeUndefined();
  });

  it('detects title_repetition when words repeat 3+ times across titles', () => {
    const entries = [
      makeEntry({ id: '1', title: 'Design Review Meeting' }),
      makeEntry({ id: '2', title: 'Design Sprint Planning' }),
      makeEntry({ id: '3', title: 'Design System Updates' }),
      makeEntry({ id: '4', title: 'Review Planning Session' }),
    ];
    // "design" appears 3 times, "review" appears 2 (not enough on its own)
    // Need 2+ words with 3+ repetitions
    // Let's ensure we have enough overlap
    const entries2 = [
      makeEntry({ id: '1', title: 'Design Review Session' }),
      makeEntry({ id: '2', title: 'Design Review Notes' }),
      makeEntry({ id: '3', title: 'Design Review Followup' }),
      makeEntry({ id: '4', title: 'Design Review Summary' }),
    ];
    const result = analyzeCycling(entries2);
    const signal = result.signals.find(s => s.type === 'title_repetition');
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe('low');
    expect(signal!.description).toContain('design');
    expect(signal!.description).toContain('review');
  });

  it('does not fire title_repetition for varied titles', () => {
    const entries = [
      makeEntry({ id: '1', title: 'Morning Standup' }),
      makeEntry({ id: '2', title: 'Database Migration' }),
      makeEntry({ id: '3', title: 'Deploy Release' }),
    ];
    const result = analyzeCycling(entries);
    const signal = result.signals.find(s => s.type === 'title_repetition');
    expect(signal).toBeUndefined();
  });

  it('respects sessionsBack option to limit entries analyzed', () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeEntry({ id: String(i), content: 'Internal musing without data' })
    );
    const result = analyzeCycling(entries, { sessionsBack: 3 });
    expect(result.entriesAnalyzed).toBe(3);
  });

  it('generates recommendation when score >= 0.4', () => {
    // Trigger no_external_data (0.3) + topic_stagnation (0.2) = 0.5
    const entries = [
      makeEntry({ id: '1', content: 'database optimization and caching strategy for production' }),
      makeEntry({ id: '2', content: 'database performance and caching layer improvements' }),
      makeEntry({ id: '3', content: 'database indexing and caching warmup strategies' }),
      makeEntry({ id: '4', content: 'database sharding and caching invalidation methods' }),
      makeEntry({ id: '5', content: 'database replication and caching eviction policies' }),
    ];
    const result = analyzeCycling(entries, { topicKeywords: ['database', 'caching'] });
    expect(result.score).toBeGreaterThanOrEqual(0.4);
    expect(result.recommendation).toBeTruthy();
    expect(result.recommendation).toContain('REQUIRED');
  });

  it('does not generate recommendation when score < 0.4', () => {
    // Only title_repetition fires = 0.1
    const entries = [
      makeEntry({ id: '1', title: 'Design Review Alpha', content: 'WebSearch found some data' }),
      makeEntry({ id: '2', title: 'Design Review Beta', content: 'WebSearch found more data' }),
      makeEntry({ id: '3', title: 'Design Review Gamma', content: 'WebSearch found even more data' }),
    ];
    const result = analyzeCycling(entries);
    expect(result.score).toBeLessThan(0.4);
    expect(result.recommendation).toBeNull();
  });

  it('caps score at 1.0', () => {
    // Trigger all three signals
    const entries = [
      makeEntry({ id: '1', title: 'Design Review Coding', content: 'database database caching caching' }),
      makeEntry({ id: '2', title: 'Design Review Coding', content: 'database database caching caching' }),
      makeEntry({ id: '3', title: 'Design Review Coding', content: 'database database caching caching' }),
      makeEntry({ id: '4', title: 'Design Review Coding', content: 'database database caching caching' }),
      makeEntry({ id: '5', title: 'Design Review Coding', content: 'database database caching caching' }),
    ];
    const result = analyzeCycling(entries, { topicKeywords: ['database', 'caching'] });
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it('supports custom externalDataPatterns', () => {
    const entries = [
      makeEntry({ id: '1', content: 'CUSTOM_FETCH: got data from API' }),
      makeEntry({ id: '2', content: 'CUSTOM_FETCH: more data' }),
      makeEntry({ id: '3', content: 'No custom fetch here' }),
    ];
    const result = analyzeCycling(entries, {
      externalDataPatterns: [/CUSTOM_FETCH/i],
    });
    // Only 1 entry without external data, so no_external_data should not fire
    const signal = result.signals.find(s => s.type === 'no_external_data');
    expect(signal).toBeUndefined();
  });
});

// ── getCyclingIntervention ──

describe('getCyclingIntervention', () => {
  it('returns empty string when score is below threshold', () => {
    const entries = [
      makeEntry({ id: '1', content: 'WebSearch found useful results' }),
      makeEntry({ id: '2', content: 'WebFetch retrieved documentation' }),
    ];
    const intervention = getCyclingIntervention(entries);
    expect(intervention).toBe('');
  });

  it('returns intervention text when score meets threshold', () => {
    const entries = [
      makeEntry({ id: '1', content: 'database and caching thoughts' }),
      makeEntry({ id: '2', content: 'database and caching analysis' }),
      makeEntry({ id: '3', content: 'database and caching review' }),
      makeEntry({ id: '4', content: 'database and caching ideas' }),
      makeEntry({ id: '5', content: 'database and caching planning' }),
    ];
    const intervention = getCyclingIntervention(entries, 0.2, {
      topicKeywords: ['database', 'caching'],
    });
    expect(intervention).toContain('CYCLING DETECTED');
  });

  it('includes signal descriptions in intervention text', () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({ id: String(i), content: 'internal thinking about database and caching' })
    );
    const intervention = getCyclingIntervention(entries, 0.2, {
      topicKeywords: ['database', 'caching'],
    });
    expect(intervention).toContain('no_external_data');
  });

  it('respects custom threshold', () => {
    // With threshold 1.0, even high cycling shouldn't trigger
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({ id: String(i), content: 'just thinking internally about stuff' })
    );
    const intervention = getCyclingIntervention(entries, 1.0);
    expect(intervention).toBe('');
  });

  it('includes required actions when recommendation exists', () => {
    const entries = [
      makeEntry({ id: '1', content: 'database and caching analysis' }),
      makeEntry({ id: '2', content: 'database and caching review' }),
      makeEntry({ id: '3', content: 'database and caching patterns' }),
      makeEntry({ id: '4', content: 'database and caching planning' }),
      makeEntry({ id: '5', content: 'database and caching design' }),
    ];
    const intervention = getCyclingIntervention(entries, 0.3, {
      topicKeywords: ['database', 'caching'],
    });
    if (intervention) {
      expect(intervention).toContain('Required actions');
    }
  });
});

// ── categorizeContent ──

describe('categorizeContent', () => {
  const categories: Record<string, AttentionCategory> = {
    coding: { weight: 1.0, keywords: ['code', 'programming', 'function'], label: 'Coding' },
    writing: { weight: 0.5, keywords: ['essay', 'writing', 'draft'], label: 'Writing' },
    admin: { weight: 0.2, keywords: ['email', 'meeting', 'schedule'], label: 'Admin' },
  };

  it('returns normalized breakdown summing to ~1.0', () => {
    const breakdown = categorizeContent(
      'code programming function essay writing email',
      categories,
    );
    const sum = Object.values(breakdown).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it('assigns higher value to category with more keyword matches', () => {
    const breakdown = categorizeContent(
      'code code code programming function essay',
      categories,
    );
    expect(breakdown.coding).toBeGreaterThan(breakdown.writing);
  });

  it('returns all zeros when no keywords match', () => {
    const breakdown = categorizeContent('nothing relevant here', categories);
    for (const val of Object.values(breakdown)) {
      expect(val).toBe(0);
    }
  });

  it('handles phrase keywords', () => {
    const phraseCategories: Record<string, AttentionCategory> = {
      devops: { weight: 1.0, keywords: ['CI/CD pipeline', 'deployment'], label: 'DevOps' },
    };
    // Phrase keywords don't use word boundaries
    const breakdown = categorizeContent('We set up a CI/CD pipeline for deployment', phraseCategories);
    expect(breakdown.devops).toBe(1.0);
  });

  it('counts multiple occurrences of the same keyword', () => {
    const breakdown = categorizeContent('code code code', categories);
    expect(breakdown.coding).toBe(1.0);
    expect(breakdown.writing).toBe(0);
  });

  it('is case-insensitive', () => {
    const breakdown = categorizeContent('CODE Programming ESSAY', categories);
    const sum = Object.values(breakdown).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 5);
    expect(breakdown.coding).toBeGreaterThan(0);
    expect(breakdown.writing).toBeGreaterThan(0);
  });
});

// ── calculateAlignmentScore ──

describe('calculateAlignmentScore', () => {
  const categories: Record<string, AttentionCategory> = {
    high: { weight: 1.0, keywords: [], label: 'High' },
    medium: { weight: 0.5, keywords: [], label: 'Medium' },
    low: { weight: 0.1, keywords: [], label: 'Low' },
  };

  it('returns 1.0 when all attention is on the highest-weight category', () => {
    const breakdown = { high: 1.0, medium: 0, low: 0 };
    const score = calculateAlignmentScore(breakdown, categories);
    expect(score).toBeCloseTo(1.0, 5);
  });

  it('returns low score when all attention is on the lowest-weight category', () => {
    const breakdown = { high: 0, medium: 0, low: 1.0 };
    const score = calculateAlignmentScore(breakdown, categories);
    expect(score).toBeCloseTo(0.1, 5);
  });

  it('returns intermediate score for mixed attention', () => {
    const breakdown = { high: 0.5, medium: 0.3, low: 0.2 };
    // (0.5*1.0 + 0.3*0.5 + 0.2*0.1) / 1.0 = 0.67
    const score = calculateAlignmentScore(breakdown, categories);
    expect(score).toBeCloseTo(0.67, 2);
  });

  it('returns 0 when all categories have weight 0', () => {
    const zeroCategories: Record<string, AttentionCategory> = {
      a: { weight: 0, keywords: [], label: 'A' },
      b: { weight: 0, keywords: [], label: 'B' },
    };
    const breakdown = { a: 0.5, b: 0.5 };
    const score = calculateAlignmentScore(breakdown, zeroCategories);
    expect(score).toBe(0);
  });

  it('handles missing categories in breakdown gracefully', () => {
    const breakdown = { high: 0.8 }; // medium and low missing
    const score = calculateAlignmentScore(breakdown, categories);
    // (0.8*1.0 + 0*0.5 + 0*0.1) / 1.0 = 0.8
    expect(score).toBeCloseTo(0.8, 5);
  });
});

// ── analyzeAttentionBudget ──

describe('analyzeAttentionBudget', () => {
  const categories: Record<string, AttentionCategory> = {
    productive: { weight: 1.0, keywords: ['code', 'build', 'design'], label: 'Productive' },
    learning: { weight: 0.7, keywords: ['study', 'read', 'learn'], label: 'Learning' },
    distraction: { weight: 0.1, keywords: ['social', 'news', 'gossip'], label: 'Distraction' },
  };

  it('returns empty result for fewer than 2 entries', () => {
    const entries = [makeEntry({ id: '1', content: 'code build design' })];
    const result = analyzeAttentionBudget(entries, categories);
    expect(result.breakdown).toEqual({});
    expect(result.alignmentScore).toBe(0);
    expect(result.alerts).toEqual([]);
    expect(result.entriesAnalyzed).toBe(1);
  });

  it('calculates normalized breakdown across multiple entries', () => {
    const entries = [
      makeEntry({ id: '1', content: 'code build design study' }),
      makeEntry({ id: '2', content: 'code code learn read' }),
    ];
    const result = analyzeAttentionBudget(entries, categories);
    const sum = Object.values(result.breakdown).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 5);
    expect(result.entriesAnalyzed).toBe(2);
  });

  it('generates over-threshold alert when a category exceeds 50%', () => {
    const entries = [
      makeEntry({ id: '1', content: 'social news gossip social news gossip social' }),
      makeEntry({ id: '2', content: 'social news gossip social news gossip social' }),
    ];
    const result = analyzeAttentionBudget(entries, categories);
    const overAlert = result.alerts.find(a => a.type === 'over_distraction');
    expect(overAlert).toBeDefined();
    expect(overAlert!.severity).toBe('warning');
  });

  it('generates under-threshold alert when highest-priority category is below 10%', () => {
    const entries = [
      makeEntry({ id: '1', content: 'study read learn study read learn' }),
      makeEntry({ id: '2', content: 'study read learn study read learn' }),
    ];
    const result = analyzeAttentionBudget(entries, categories);
    // productive has 0 keywords matched, should be under 10%
    const underAlert = result.alerts.find(a => a.type === 'under_productive');
    expect(underAlert).toBeDefined();
    expect(underAlert!.severity).toBe('info');
  });

  it('generates low-priority domination alert when lowest-weight category exceeds 30%', () => {
    const entries = [
      makeEntry({ id: '1', content: 'social news gossip social news gossip' }),
      makeEntry({ id: '2', content: 'social news gossip code build' }),
    ];
    const result = analyzeAttentionBudget(entries, categories);
    const lowPriorityAlert = result.alerts.find(a =>
      a.type.startsWith('over_low_priority_')
    );
    expect(lowPriorityAlert).toBeDefined();
    expect(lowPriorityAlert!.severity).toBe('warning');
    expect(lowPriorityAlert!.message).toContain('consider more practical topics');
  });

  it('respects sessionsBack option', () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      makeEntry({ id: String(i), content: 'code build design study' })
    );
    const result = analyzeAttentionBudget(entries, categories, { sessionsBack: 3 });
    expect(result.entriesAnalyzed).toBe(3);
  });

  it('calculates positive alignment score for productive content', () => {
    const entries = [
      makeEntry({ id: '1', content: 'code code build build design design' }),
      makeEntry({ id: '2', content: 'code code build build design design' }),
    ];
    const result = analyzeAttentionBudget(entries, categories);
    expect(result.alignmentScore).toBeGreaterThan(0.5);
  });

  it('calculates low alignment score for distraction-heavy content', () => {
    const entries = [
      makeEntry({ id: '1', content: 'social social news gossip gossip news' }),
      makeEntry({ id: '2', content: 'social social news gossip gossip news' }),
    ];
    const result = analyzeAttentionBudget(entries, categories);
    expect(result.alignmentScore).toBeLessThan(0.5);
  });

  it('respects custom overThreshold', () => {
    const entries = [
      makeEntry({ id: '1', content: 'code code code' }),
      makeEntry({ id: '2', content: 'code code code' }),
    ];
    // With threshold 0.9, productive at 100% still fires
    const result = analyzeAttentionBudget(entries, categories, { overThreshold: 0.9 });
    const overAlert = result.alerts.find(a => a.type === 'over_productive');
    expect(overAlert).toBeDefined();
  });

  it('respects custom underThreshold', () => {
    const entries = [
      makeEntry({ id: '1', content: 'study read learn study read' }),
      makeEntry({ id: '2', content: 'study read learn study read' }),
    ];
    // productive = 0%, underThreshold = 0.5 should trigger
    const result = analyzeAttentionBudget(entries, categories, { underThreshold: 0.5 });
    const underAlert = result.alerts.find(a => a.type === 'under_productive');
    expect(underAlert).toBeDefined();
  });
});
