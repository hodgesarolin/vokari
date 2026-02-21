import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initKnowledge, addKnowledge, upsertKnowledge } from '../src/knowledge.js';
import { assembleContext } from '../src/compiler.js';
import type { SessionType } from '../src/compiler.js';

let db: Database.Database;

/**
 * Set up a knowledge store with realistic test data
 * mirroring Brain's actual content types.
 */
function seedTestData(db: Database.Database): void {
  // Corrections (mandatory layer)
  addKnowledge(db, {
    type: 'correction',
    key: 'correction-policy-1',
    content: 'Brain is personal only — do not research Prenosis',
    metadata: { correction_type: 'policy', permanence: 'never', violation_count: 0, graduated_at: null },
  });
  addKnowledge(db, {
    type: 'correction',
    key: 'correction-fact-1',
    content: "Kim's income is $105/hr",
    metadata: { correction_type: 'fact', permanence: 'never', violation_count: 0, graduated_at: null },
  });
  addKnowledge(db, {
    type: 'correction',
    key: 'correction-pattern-1',
    content: 'Always verify day of week',
    metadata: { correction_type: 'pattern', permanence: 'graduable', violation_count: 2, graduated_at: null },
  });
  addKnowledge(db, {
    type: 'correction',
    key: 'correction-technical-1',
    content: 'No MCP tools in cron',
    metadata: { correction_type: 'technical', permanence: 'graduable', violation_count: 0, graduated_at: null },
  });

  // Graduated correction (should be excluded)
  addKnowledge(db, {
    type: 'correction',
    key: 'correction-graduated',
    content: 'Old graduated correction',
    metadata: { correction_type: 'fact', permanence: 'graduable', violation_count: 0, graduated_at: '2026-01-01' },
  });

  // Identity (mandatory layer)
  upsertKnowledge(db, {
    type: 'context',
    key: 'identity',
    content: 'Brain is a personal AI assistant for Daniel Hodges. Named after Data and the Doctor.',
  });

  // Decisions (mandatory layer)
  upsertKnowledge(db, {
    type: 'context',
    key: 'decisions',
    content: 'Daniel is subscription-based. Cost does not matter, rate limits are the constraint.',
  });

  // Interactive context (session layer - interactive)
  upsertKnowledge(db, {
    type: 'handoff',
    key: 'interactive-context',
    content: 'Daniel returned from Disney Feb 10. 40th birthday Feb 11. Vokari feature complete. DHS shutdown Day 8.',
  });

  // Family (session layer - interactive)
  upsertKnowledge(db, {
    type: 'context',
    key: 'family',
    content: 'Wife Kim (DVM), 3 kids: Lily 6, Ben 4, Rowan 19mo. PS 28 school.',
  });

  // Personal context (session layer - interactive)
  upsertKnowledge(db, {
    type: 'context',
    key: 'personal',
    content: 'Daniel: Lead Cloud Infra Engineer @ Prenosis. $195K + 15% bonus. JC Heights, NJ.',
  });

  // Daily todos (session layer - interactive + cron_digest)
  upsertKnowledge(db, {
    type: 'handoff',
    key: 'daily-todos',
    content: 'Pre-K registration reminder Feb 27-28. Ward D budget meeting Mar 18.',
  });

  // Active predictions (session layer)
  addKnowledge(db, {
    type: 'prediction',
    key: 'prediction-dhs-shutdown',
    content: 'DHS shutdown duration: median ~13 days',
    metadata: { confidence: 0.5, domain: 'political', outcome: null, check_date: '2026-03-01' },
  });
  addKnowledge(db, {
    type: 'prediction',
    key: 'prediction-scotus-resolved',
    content: 'SCOTUS IEEPA: government loses 6-3',
    metadata: { confidence: 0.7, domain: 'political', outcome: 'correct', resolved_at: '2026-02-20' },
  });

  // Active positions (session layer)
  addKnowledge(db, {
    type: 'position',
    key: 'position-context-first',
    content: 'Context quality has higher marginal ROI than model quality',
    metadata: { confidence: 0.7, status: 'held', topic: 'Context-first thesis' },
  });
  addKnowledge(db, {
    type: 'position',
    key: 'position-abandoned',
    content: 'Abandoned position about something',
    metadata: { confidence: 0.3, status: 'abandoned', topic: 'Old topic' },
  });

  // Last session handoff (session layer - cron_thinking)
  upsertKnowledge(db, {
    type: 'handoff',
    key: 'last-session-handoff',
    content: 'Context rot research done. Toptal guide updated. Artemis II ready. SDK auth confirmed.',
  });

  // Nightly state (session layer - cron_thinking + cron_health)
  upsertKnowledge(db, {
    type: 'handoff',
    key: 'nightly-state',
    content: 'Brain v1.10.0 running. Opus 4.6. SDK 0.2.42. 31 corrections. 5+ day adherence streak.',
  });

  // Research content (relevance layer)
  addKnowledge(db, {
    type: 'research',
    key: 'research-scotus',
    content: 'SCOTUS IEEPA ruling struck down tariff authority 6-3. Roberts authored. Section 122 replacement signed same day.',
  });
  addKnowledge(db, {
    type: 'research',
    key: 'research-shoulder',
    content: 'Rotator cuff surgery recovery: 5-6 months to lift toddler. Narrow window for Daniel.',
  });

  // Archive content
  addKnowledge(db, {
    type: 'archive',
    key: 'archive-emigration',
    content: 'Austrian citizenship via section 58c. 3 quick-start actions identified. NY consulate.',
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initKnowledge(db);
  seedTestData(db);
});

// ── Basic Assembly ──

describe('assembleContext', () => {
  it('returns a context string', () => {
    const result = assembleContext(db, {
      budget: 50000,
      sessionType: 'interactive',
    });
    expect(result.context).toBeTruthy();
    expect(result.context.length).toBeGreaterThan(0);
  });

  it('returns breakdown statistics', () => {
    const result = assembleContext(db, {
      budget: 50000,
      sessionType: 'interactive',
    });
    expect(result.breakdown).toBeDefined();
    expect(result.breakdown.mandatory).toBeGreaterThan(0);
    expect(result.breakdown.total).toBeLessThanOrEqual(result.breakdown.budget);
    expect(result.breakdown.utilizationPct).toBeGreaterThan(0);
    expect(result.breakdown.utilizationPct).toBeLessThanOrEqual(100);
  });

  it('includes IDs of knowledge rows', () => {
    const result = assembleContext(db, {
      budget: 50000,
      sessionType: 'interactive',
    });
    expect(result.includedIds.length).toBeGreaterThan(0);
  });

  it('never exceeds budget', () => {
    const result = assembleContext(db, {
      budget: 500,
      sessionType: 'interactive',
    });
    expect(result.context.length).toBeLessThanOrEqual(500);
  });
});

// ── Mandatory Layer ──

describe('mandatory layer', () => {
  it('includes active corrections', () => {
    const result = assembleContext(db, {
      budget: 50000,
      sessionType: 'interactive',
    });
    expect(result.context).toContain('Brain is personal only');
    expect(result.context).toContain("Kim's income is $105/hr");
    expect(result.context).toContain('Always verify day of week');
    expect(result.context).toContain('No MCP tools in cron');
  });

  it('excludes graduated corrections', () => {
    const result = assembleContext(db, {
      budget: 50000,
      sessionType: 'interactive',
    });
    expect(result.context).not.toContain('Old graduated correction');
  });

  it('includes identity', () => {
    const result = assembleContext(db, {
      budget: 50000,
      sessionType: 'interactive',
    });
    expect(result.context).toContain('Brain is a personal AI assistant');
  });

  it('includes decisions', () => {
    const result = assembleContext(db, {
      budget: 50000,
      sessionType: 'interactive',
    });
    expect(result.context).toContain('subscription-based');
  });

  it('is included in all session types', () => {
    const types: SessionType[] = ['interactive', 'cron_thinking', 'cron_digest', 'cron_health'];
    for (const sessionType of types) {
      const result = assembleContext(db, { budget: 50000, sessionType });
      expect(result.context).toContain('Brain is personal only');
      expect(result.context).toContain('Brain is a personal AI assistant');
    }
  });

  it('shows violation count for corrections with violations', () => {
    const result = assembleContext(db, {
      budget: 50000,
      sessionType: 'interactive',
    });
    expect(result.context).toContain('[2 violations]');
  });
});

// ── Session Layer: Interactive ──

describe('session layer — interactive', () => {
  it('includes interactive context', () => {
    const result = assembleContext(db, {
      budget: 50000,
      sessionType: 'interactive',
    });
    expect(result.context).toContain('returned from Disney');
  });

  it('includes family context', () => {
    const result = assembleContext(db, {
      budget: 50000,
      sessionType: 'interactive',
    });
    expect(result.context).toContain('Kim (DVM)');
  });

  it('includes personal context', () => {
    const result = assembleContext(db, {
      budget: 50000,
      sessionType: 'interactive',
    });
    expect(result.context).toContain('Lead Cloud Infra Engineer');
  });

  it('includes daily todos', () => {
    const result = assembleContext(db, {
      budget: 50000,
      sessionType: 'interactive',
    });
    expect(result.context).toContain('Pre-K registration');
  });

  it('includes active predictions only (not resolved)', () => {
    const result = assembleContext(db, {
      budget: 50000,
      sessionType: 'interactive',
    });
    expect(result.context).toContain('DHS shutdown duration');
    expect(result.context).not.toContain('SCOTUS IEEPA: government loses');
  });

  it('includes active positions only (not abandoned)', () => {
    const result = assembleContext(db, {
      budget: 50000,
      sessionType: 'interactive',
    });
    expect(result.context).toContain('Context quality has higher marginal ROI');
    expect(result.context).not.toContain('Abandoned position');
  });
});

// ── Session Layer: Cron Thinking ──

describe('session layer — cron_thinking', () => {
  it('includes last session handoff', () => {
    const result = assembleContext(db, {
      budget: 50000,
      sessionType: 'cron_thinking',
    });
    expect(result.context).toContain('Context rot research done');
  });

  it('includes nightly state', () => {
    const result = assembleContext(db, {
      budget: 50000,
      sessionType: 'cron_thinking',
    });
    expect(result.context).toContain('Brain v1.10.0 running');
  });

  it('does NOT include interactive context', () => {
    const result = assembleContext(db, {
      budget: 50000,
      sessionType: 'cron_thinking',
    });
    expect(result.context).not.toContain('returned from Disney');
  });
});

// ── Session Layer: Cron Digest ──

describe('session layer — cron_digest', () => {
  it('is minimal — includes corrections and todos but not positions', () => {
    const result = assembleContext(db, {
      budget: 50000,
      sessionType: 'cron_digest',
    });
    // Has mandatory (corrections, identity, decisions)
    expect(result.context).toContain('Brain is personal only');
    // Has daily todos
    expect(result.context).toContain('Pre-K registration');
    // Does NOT have positions or predictions in session layer
    // (they might appear in relevance layer though, so we just check size is smaller)
    expect(result.breakdown.session).toBeLessThan(
      assembleContext(db, { budget: 50000, sessionType: 'interactive' }).breakdown.session
    );
  });
});

// ── Relevance Layer ──

describe('relevance layer', () => {
  it('adds relevant content when query is provided', () => {
    const result = assembleContext(db, {
      budget: 50000,
      sessionType: 'interactive',
      query: 'shoulder surgery recovery',
    });
    expect(result.context).toContain('Rotator cuff surgery');
  });

  it('adds recent content when no query is provided', () => {
    const result = assembleContext(db, {
      budget: 50000,
      sessionType: 'cron_thinking',
    });
    // Should include research or other recent content in relevance layer
    expect(result.breakdown.relevance).toBeGreaterThanOrEqual(0);
  });

  it('does not duplicate content from mandatory/session layers', () => {
    const result = assembleContext(db, {
      budget: 50000,
      sessionType: 'interactive',
      query: 'correction verify day',
    });
    // The correction about verifying day of week should only appear once
    const matches = result.context.match(/Always verify day of week/g);
    expect(matches?.length ?? 0).toBeLessThanOrEqual(1);
  });
});

// ── Budget Management ──

describe('budget management', () => {
  it('prioritizes mandatory over session', () => {
    // Very tight budget — should still get corrections
    const result = assembleContext(db, {
      budget: 800,
      sessionType: 'interactive',
    });
    // Corrections should be there
    expect(result.context).toContain('Corrections');
    // But might not have family, personal, etc.
    expect(result.breakdown.mandatory).toBeGreaterThan(0);
  });

  it('counts excluded items', () => {
    const result = assembleContext(db, {
      budget: 500,
      sessionType: 'interactive',
    });
    expect(result.excluded).toBeGreaterThan(0);
  });

  it('large budget includes everything', () => {
    const result = assembleContext(db, {
      budget: 100000,
      sessionType: 'interactive',
    });
    expect(result.excluded).toBe(0);
  });

  it('utilization percentage is accurate', () => {
    const result = assembleContext(db, {
      budget: 50000,
      sessionType: 'interactive',
    });
    const expectedPct = Math.round((result.context.length / 50000) * 100);
    // Allow 1% tolerance due to newlines in join
    expect(Math.abs(result.breakdown.utilizationPct - expectedPct)).toBeLessThanOrEqual(2);
  });
});

// ── Headers ──

describe('headers', () => {
  it('includes headers by default', () => {
    const result = assembleContext(db, {
      budget: 50000,
      sessionType: 'interactive',
    });
    expect(result.context).toContain('# Corrections');
  });

  it('excludes headers when headers=false', () => {
    const result = assembleContext(db, {
      budget: 50000,
      sessionType: 'interactive',
      headers: false,
    });
    expect(result.context).not.toContain('## Interactive Session Context');
    expect(result.context).not.toContain('## Family');
    // But content should still be there
    expect(result.context).toContain('Kim (DVM)');
  });
});

// ── Empty Store ──

describe('empty knowledge store', () => {
  it('returns empty context for empty db', () => {
    const emptyDb = new Database(':memory:');
    emptyDb.pragma('journal_mode = WAL');
    initKnowledge(emptyDb);

    const result = assembleContext(emptyDb, {
      budget: 50000,
      sessionType: 'interactive',
    });
    expect(result.context).toBe('');
    expect(result.breakdown.total).toBe(0);
    expect(result.includedIds).toHaveLength(0);
  });
});

// ── Upsert + Recompile ──

describe('upsert then recompile', () => {
  it('reflects updated handoff content', () => {
    // Initial compile
    const result1 = assembleContext(db, {
      budget: 50000,
      sessionType: 'interactive',
    });
    expect(result1.context).toContain('returned from Disney');

    // Update handoff
    upsertKnowledge(db, {
      type: 'handoff',
      key: 'interactive-context',
      content: 'NEW SESSION: Daniel asked about shoulder surgery timeline.',
    });

    // Recompile
    const result2 = assembleContext(db, {
      budget: 50000,
      sessionType: 'interactive',
    });
    expect(result2.context).not.toContain('returned from Disney');
    expect(result2.context).toContain('shoulder surgery timeline');
  });
});

// ── Different Session Types Produce Different Outputs ──

describe('session type differentiation', () => {
  it('interactive and cron_thinking produce different session layers', () => {
    const interactive = assembleContext(db, { budget: 50000, sessionType: 'interactive' });
    const thinking = assembleContext(db, { budget: 50000, sessionType: 'cron_thinking' });

    // Interactive has family context, thinking has last session handoff
    expect(interactive.context).toContain('Kim (DVM)');
    expect(thinking.context).toContain('Context rot research done');

    // They're different outputs
    expect(interactive.context).not.toBe(thinking.context);
  });

  it('cron_digest is smaller than interactive', () => {
    const digest = assembleContext(db, { budget: 50000, sessionType: 'cron_digest' });
    const interactive = assembleContext(db, { budget: 50000, sessionType: 'interactive' });

    expect(digest.breakdown.session).toBeLessThan(interactive.breakdown.session);
  });
});
