import { describe, it, expect } from 'vitest';
import {
  classifyLine,
  extractSignal,
  buildDigest,
  compactLog,
  getRecurringThemes,
  DEFAULT_NOISE_PATTERNS,
  DEFAULT_SIGNAL_PATTERNS,
} from '../src/distill.js';
import type { CompactionRules } from '../src/distill.js';

// ── classifyLine ──

describe('classifyLine', () => {
  it('classifies empty line as not signal with category "empty"', () => {
    const result = classifyLine('', DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    expect(result.isSignal).toBe(false);
    expect(result.category).toBe('empty');
  });

  it('classifies whitespace-only line as empty', () => {
    const result = classifyLine('   ', DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    expect(result.isSignal).toBe(false);
    expect(result.category).toBe('empty');
  });

  it('classifies noise: "cron job started"', () => {
    const result = classifyLine('cron job started', DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    expect(result.isSignal).toBe(false);
    expect(result.category).toBe('operational');
  });

  it('classifies noise: "task completed"', () => {
    const result = classifyLine('task completed', DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    expect(result.isSignal).toBe(false);
    expect(result.category).toBe('operational');
  });

  it('classifies noise: "transcript saved"', () => {
    const result = classifyLine('transcript saved', DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    expect(result.isSignal).toBe(false);
    expect(result.category).toBe('operational');
  });

  it('classifies noise: "session archived"', () => {
    const result = classifyLine('session archived', DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    expect(result.isSignal).toBe(false);
    expect(result.category).toBe('operational');
  });

  it('classifies noise: "health check passed"', () => {
    const result = classifyLine('health check passed', DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    expect(result.isSignal).toBe(false);
    expect(result.category).toBe('operational');
  });

  it('classifies noise: "heartbeat"', () => {
    const result = classifyLine('heartbeat', DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    expect(result.isSignal).toBe(false);
    expect(result.category).toBe('operational');
  });

  it('classifies noise: "cache cleared"', () => {
    const result = classifyLine('cache cleared', DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    expect(result.isSignal).toBe(false);
    expect(result.category).toBe('operational');
  });

  it('classifies noise: "retrying in 5"', () => {
    const result = classifyLine('retrying in 5', DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    expect(result.isSignal).toBe(false);
    expect(result.category).toBe('operational');
  });

  it('classifies signal: "chat from user"', () => {
    const result = classifyLine('chat from user', DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    expect(result.isSignal).toBe(true);
    expect(result.category).toBe('conversation');
  });

  it('classifies signal: "ticket created"', () => {
    const result = classifyLine('ticket created', DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    expect(result.isSignal).toBe(true);
    expect(result.category).toBe('ticket');
  });

  it('classifies signal: "decided to use Postgres"', () => {
    const result = classifyLine('decided to use Postgres', DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    expect(result.isSignal).toBe(true);
    expect(result.category).toBe('decision');
  });

  it('classifies signal: "config updated"', () => {
    const result = classifyLine('config updated', DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    expect(result.isSignal).toBe(true);
    expect(result.category).toBe('config-change');
  });

  it('classifies signal: "[ALERT] disk full"', () => {
    const result = classifyLine('[ALERT] disk full', DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    expect(result.isSignal).toBe(true);
    expect(result.category).toBe('error');
  });

  it('classifies signal: "[ERROR] connection refused"', () => {
    const result = classifyLine('[ERROR] connection refused', DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    expect(result.isSignal).toBe(true);
    expect(result.category).toBe('error');
  });

  it('classifies signal: "unhandled rejection"', () => {
    const result = classifyLine('unhandled rejection in module', DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    expect(result.isSignal).toBe(true);
    expect(result.category).toBe('error');
  });

  it('classifies signal: "job backup failed"', () => {
    const result = classifyLine('job backup failed', DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    expect(result.isSignal).toBe(true);
    expect(result.category).toBe('error');
  });

  it('classifies signal: "deployment started"', () => {
    const result = classifyLine('deployment started', DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    expect(result.isSignal).toBe(true);
    expect(result.category).toBe('deployment');
  });

  it('classifies signal: "migration completed"', () => {
    const result = classifyLine('migration completed', DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    expect(result.isSignal).toBe(true);
    expect(result.category).toBe('deployment');
  });

  it('defaults unknown lines to signal with category "other"', () => {
    const result = classifyLine('some random log line about pizza', DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    expect(result.isSignal).toBe(true);
    expect(result.category).toBe('other');
  });

  it('checks noise patterns before signal patterns', () => {
    // A line that matches both noise and signal should be classified as noise
    // "job backup skipped" matches noise (job skipped) pattern
    const result = classifyLine('job backup skipped', DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    expect(result.isSignal).toBe(false);
    expect(result.category).toBe('operational');
  });
});

// ── extractSignal ──

describe('extractSignal', () => {
  it('separates signal lines from noise lines', () => {
    const content = [
      'cron job started',
      '[ERROR] disk full',
      'heartbeat',
      'ticket created',
    ].join('\n');
    const result = extractSignal(content, DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    expect(result.signal).toEqual(['[ERROR] disk full', 'ticket created']);
    expect(result.noise).toBe(2);
    expect(result.total).toBe(4);
  });

  it('returns category breakdown', () => {
    const content = [
      'cron job started',
      '[ERROR] disk full',
      'ticket created',
    ].join('\n');
    const result = extractSignal(content, DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    expect(result.categories.operational).toBe(1);
    expect(result.categories.error).toBe(1);
    expect(result.categories.ticket).toBe(1);
  });

  it('skips empty lines in counts', () => {
    const content = [
      'cron job started',
      '',
      '',
      '[ERROR] something broke',
    ].join('\n');
    const result = extractSignal(content, DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    expect(result.total).toBe(2);
  });

  it('treats unknown lines as signal', () => {
    const content = 'some unique log entry';
    const result = extractSignal(content, DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    expect(result.signal).toEqual(['some unique log entry']);
    expect(result.noise).toBe(0);
    expect(result.categories.other).toBe(1);
  });

  it('handles empty content', () => {
    const result = extractSignal('', DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    expect(result.signal).toEqual([]);
    expect(result.noise).toBe(0);
    expect(result.total).toBe(0);
  });
});

// ── buildDigest ──

describe('buildDigest', () => {
  it('builds a markdown digest with title and stats', () => {
    const content = [
      '[ERROR] out of memory',
      'cron job started',
      'ticket created for bug #42',
    ].join('\n');
    const digest = buildDigest('2025-01-15', content, DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    expect(digest).toContain('# Digest -- 2025-01-15');
    expect(digest).toContain('2 signal lines extracted from 3 total (1 noise filtered)');
  });

  it('groups signal lines by category', () => {
    const content = [
      '[ERROR] disk full',
      '[ERROR] memory leak',
      'ticket created for feature request',
      'decided to upgrade database',
    ].join('\n');
    const digest = buildDigest('test', content, DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    expect(digest).toContain('## Error');
    expect(digest).toContain('## Ticket');
    expect(digest).toContain('## Decision');
  });

  it('shows "No signal lines found." when all lines are noise', () => {
    const content = [
      'cron job started',
      'heartbeat',
      'cache cleared',
    ].join('\n');
    const digest = buildDigest('empty-day', content, DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    expect(digest).toContain('No signal lines found.');
  });

  it('orders categories with errors first', () => {
    const content = [
      'ticket created',
      '[ERROR] bad thing',
      'decided to fix it',
    ].join('\n');
    const digest = buildDigest('test', content, DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    const errorIdx = digest.indexOf('## Error');
    const ticketIdx = digest.indexOf('## Ticket');
    const decisionIdx = digest.indexOf('## Decision');
    expect(errorIdx).toBeLessThan(decisionIdx);
    expect(decisionIdx).toBeLessThan(ticketIdx);
  });

  it('capitalizes multi-word category names', () => {
    const content = 'config updated to new values';
    const digest = buildDigest('test', content, DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    expect(digest).toContain('## Config Change');
  });
});

// ── compactLog ──

describe('compactLog', () => {
  const rules: CompactionRules = {
    preserve: [/\[ERROR\]/i, /\[CRITICAL\]/i],
    collapse: [
      { pattern: /heartbeat/i, group: 'heartbeat', key: null },
      { pattern: /cache (\w+)/i, group: 'cache', key: 1 },
    ],
    remove: [/^debug:/i],
  };

  it('preserves lines matching preserve patterns', () => {
    const content = '[ERROR] something broke\n[CRITICAL] system down';
    const result = compactLog(content, rules);
    expect(result.compacted).toContain('[ERROR] something broke');
    expect(result.compacted).toContain('[CRITICAL] system down');
  });

  it('removes lines matching remove patterns', () => {
    const content = 'debug: verbose output\n[ERROR] real problem';
    const result = compactLog(content, rules);
    expect(result.compacted).not.toContain('debug: verbose output');
    expect(result.compacted).toContain('[ERROR] real problem');
  });

  it('collapses repetitive lines into counts', () => {
    const content = [
      'heartbeat',
      'heartbeat',
      'heartbeat',
      '[ERROR] real issue',
    ].join('\n');
    const result = compactLog(content, rules);
    expect(result.compacted).toContain('[Compacted] 3 heartbeat events');
    expect(result.compacted).toContain('[ERROR] real issue');
  });

  it('collapses with sub-keys when capture groups are provided', () => {
    const content = [
      'cache hit',
      'cache hit',
      'cache miss',
      'cache cleared',
    ].join('\n');
    const result = compactLog(content, rules);
    expect(result.compacted).toContain('[Compacted]');
    expect(result.compacted).toContain('cache events');
    expect(result.compacted).toContain('hit');
    expect(result.compacted).toContain('miss');
  });

  it('preserves unmatched lines by default', () => {
    const content = 'some random line that matches nothing';
    const result = compactLog(content, rules);
    expect(result.compacted).toContain('some random line that matches nothing');
  });

  it('preserves empty lines as structural elements', () => {
    const content = 'line one\n\nline two';
    const result = compactLog(content, rules);
    expect(result.compacted).toContain('line one');
    expect(result.compacted).toContain('line two');
  });

  it('returns correct stats', () => {
    const content = [
      '[ERROR] real issue',
      'heartbeat',
      'heartbeat',
      'debug: verbose',
    ].join('\n');
    const result = compactLog(content, rules);
    expect(result.stats.originalLines).toBe(4);
    expect(result.stats.preservedLines).toBe(1);
    expect(result.stats.collapsedGroups).toBe(1);
  });

  it('reports compression ratio', () => {
    const content = [
      'heartbeat',
      'heartbeat',
      'heartbeat',
      'heartbeat',
      'heartbeat',
      '[ERROR] keep this',
    ].join('\n');
    const result = compactLog(content, rules);
    const ratio = parseFloat(result.stats.compressionRatio);
    expect(ratio).toBeGreaterThan(0);
  });

  it('adds Compacted Summary section', () => {
    const content = 'heartbeat\nheartbeat';
    const result = compactLog(content, rules);
    expect(result.compacted).toContain('### Compacted Summary');
  });

  it('handles empty content', () => {
    const result = compactLog('', rules);
    expect(result.compacted).toBe('');
    expect(result.stats.originalLines).toBe(0);
  });
});

// ── getRecurringThemes ──

describe('getRecurringThemes', () => {
  it('finds words appearing in 2+ documents', () => {
    const contents = [
      'database performance optimization query',
      'database indexing optimization plan',
      'frontend rendering layout styling',
    ];
    const themes = getRecurringThemes(contents);
    const words = themes.map(t => t.word);
    expect(words).toContain('database');
    expect(words).toContain('optimization');
  });

  it('returns empty array when no word appears in 2+ documents', () => {
    const contents = [
      'alpha bravo charlie',
      'delta echo foxtrot',
    ];
    const themes = getRecurringThemes(contents);
    expect(themes).toEqual([]);
  });

  it('counts document frequency, not total occurrences', () => {
    const contents = [
      'database database database database',
      'server query processing',
    ];
    const themes = getRecurringThemes(contents);
    const dbTheme = themes.find(t => t.word === 'database');
    // "database" only appears in 1 document, so it should not be included
    expect(dbTheme).toBeUndefined();
  });

  it('filters stop words', () => {
    const contents = [
      'the quick brown fox signal lines noise',
      'the quick brown fox signal lines noise',
    ];
    const themes = getRecurringThemes(contents);
    const words = themes.map(t => t.word);
    expect(words).not.toContain('the');
    expect(words).not.toContain('signal');
    expect(words).not.toContain('lines');
    expect(words).not.toContain('noise');
  });

  it('filters words shorter than 3 characters', () => {
    const contents = [
      'go up to me it',
      'go up to me it',
    ];
    const themes = getRecurringThemes(contents);
    expect(themes).toEqual([]);
  });

  it('respects minDocuments option', () => {
    const contents = [
      'database optimization query',
      'database optimization plan',
      'database server config',
    ];
    const themes = getRecurringThemes(contents, { minDocuments: 3 });
    const words = themes.map(t => t.word);
    expect(words).toContain('database');
    // "optimization" only in 2 docs, should be excluded with minDocuments=3
    expect(words).not.toContain('optimization');
  });

  it('respects maxThemes option', () => {
    const contents = [
      'alpha bravo charlie delta echo foxtrot golf hotel india juliet',
      'alpha bravo charlie delta echo foxtrot golf hotel india juliet',
    ];
    const themes = getRecurringThemes(contents, { maxThemes: 3 });
    expect(themes.length).toBeLessThanOrEqual(3);
  });

  it('respects extraStopWords option', () => {
    const contents = [
      'database optimization caching',
      'database optimization caching',
    ];
    const themes = getRecurringThemes(contents, { extraStopWords: ['database'] });
    const words = themes.map(t => t.word);
    expect(words).not.toContain('database');
    expect(words).toContain('optimization');
  });

  it('includes totalDocuments in results', () => {
    const contents = ['database query', 'database plan', 'server config'];
    const themes = getRecurringThemes(contents);
    for (const theme of themes) {
      expect(theme.totalDocuments).toBe(3);
    }
  });

  it('includes correct documentCount', () => {
    const contents = [
      'database optimization',
      'database optimization',
      'database server',
    ];
    const themes = getRecurringThemes(contents);
    const dbTheme = themes.find(t => t.word === 'database');
    expect(dbTheme).toBeDefined();
    expect(dbTheme!.documentCount).toBe(3);
  });

  it('sorts by document frequency descending', () => {
    const contents = [
      'database optimization caching',
      'database optimization server',
      'database caching layer',
    ];
    const themes = getRecurringThemes(contents);
    for (let i = 1; i < themes.length; i++) {
      expect(themes[i - 1].documentCount).toBeGreaterThanOrEqual(themes[i].documentCount);
    }
  });
});

// ── DEFAULT_NOISE_PATTERNS ──

describe('DEFAULT_NOISE_PATTERNS', () => {
  it('is an array of classification rules', () => {
    expect(Array.isArray(DEFAULT_NOISE_PATTERNS)).toBe(true);
    expect(DEFAULT_NOISE_PATTERNS.length).toBeGreaterThan(0);
  });

  it('each rule has pattern and category properties', () => {
    for (const rule of DEFAULT_NOISE_PATTERNS) {
      expect(rule.pattern).toBeInstanceOf(RegExp);
      expect(typeof rule.category).toBe('string');
    }
  });

  it('all rules have "operational" category', () => {
    for (const rule of DEFAULT_NOISE_PATTERNS) {
      expect(rule.category).toBe('operational');
    }
  });
});

// ── DEFAULT_SIGNAL_PATTERNS ──

describe('DEFAULT_SIGNAL_PATTERNS', () => {
  it('is an array of classification rules', () => {
    expect(Array.isArray(DEFAULT_SIGNAL_PATTERNS)).toBe(true);
    expect(DEFAULT_SIGNAL_PATTERNS.length).toBeGreaterThan(0);
  });

  it('each rule has pattern and category properties', () => {
    for (const rule of DEFAULT_SIGNAL_PATTERNS) {
      expect(rule.pattern).toBeInstanceOf(RegExp);
      expect(typeof rule.category).toBe('string');
    }
  });

  it('covers multiple categories', () => {
    const categories = new Set(DEFAULT_SIGNAL_PATTERNS.map(r => r.category));
    expect(categories.size).toBeGreaterThan(3);
    expect(categories.has('conversation')).toBe(true);
    expect(categories.has('error')).toBe(true);
    expect(categories.has('decision')).toBe(true);
  });
});
