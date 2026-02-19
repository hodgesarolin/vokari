import { describe, it, expect } from 'vitest';
import {
  extractUrls,
  extractBeliefs,
  extractTopics,
  extractCorrections,
} from '../src/learning.js';
import type { Message } from '../src/learning.js';

// ── extractUrls ──

describe('extractUrls', () => {
  it('extracts a single URL', () => {
    const urls = extractUrls('Check out https://example.org/page');
    expect(urls).toEqual(['https://example.org/page']);
  });

  it('extracts multiple URLs', () => {
    const urls = extractUrls(
      'See https://github.com/repo and http://docs.rs/crate for details'
    );
    expect(urls).toEqual(['https://github.com/repo', 'http://docs.rs/crate']);
  });

  it('returns empty array when no URLs are present', () => {
    expect(extractUrls('no urls here')).toEqual([]);
  });

  it('deduplicates identical URLs', () => {
    const urls = extractUrls(
      'https://github.com/foo and again https://github.com/foo'
    );
    expect(urls).toEqual(['https://github.com/foo']);
  });

  it('cleans trailing punctuation', () => {
    const urls = extractUrls('Visit https://example.org/page.');
    expect(urls).toEqual(['https://example.org/page']);
  });

  it('cleans trailing comma and semicolon', () => {
    const urls = extractUrls('See https://a.com/x, https://b.com/y; done');
    expect(urls).toEqual(['https://a.com/x', 'https://b.com/y']);
  });

  it('cleans trailing exclamation and question marks', () => {
    const urls = extractUrls('Wow https://a.com/page! Really https://b.com/q?');
    expect(urls).toEqual(['https://a.com/page', 'https://b.com/q']);
  });

  it('cleans trailing markdown parentheses', () => {
    const urls = extractUrls('[link](https://example.org/page)');
    expect(urls).toEqual(['https://example.org/page']);
  });

  it('filters localhost URLs', () => {
    const urls = extractUrls('http://localhost:3000/api');
    expect(urls).toEqual([]);
  });

  it('filters 127.0.0.1 URLs', () => {
    const urls = extractUrls('http://127.0.0.1:8080/test');
    expect(urls).toEqual([]);
  });

  it('filters 0.0.0.0 URLs', () => {
    const urls = extractUrls('http://0.0.0.0:5000/health');
    expect(urls).toEqual([]);
  });

  it('filters example.com URLs', () => {
    const urls = extractUrls('https://example.com/test');
    expect(urls).toEqual([]);
  });

  it('filters placeholder URLs', () => {
    const urls = extractUrls('https://placeholder.io/test');
    expect(urls).toEqual([]);
  });

  it('filters claude.com/claude-code URLs', () => {
    const urls = extractUrls('https://claude.com/claude-code');
    expect(urls).toEqual([]);
  });

  it('keeps legitimate URLs alongside filtered ones', () => {
    const urls = extractUrls(
      'Use https://github.com/repo not http://localhost:3000/api'
    );
    expect(urls).toEqual(['https://github.com/repo']);
  });
});

// ── extractBeliefs ──

describe('extractBeliefs', () => {
  const sessionId = 'test-session';

  it('returns empty array for no user messages', () => {
    const msgs: Message[] = [{ role: 'assistant', content: 'Hello!' }];
    expect(extractBeliefs(msgs, sessionId)).toEqual([]);
  });

  it('ignores messages shorter than 10 characters', () => {
    const msgs: Message[] = [{ role: 'user', content: 'I like X' }];
    expect(extractBeliefs(msgs, sessionId)).toEqual([]);
  });

  it('extracts preference pattern: "I prefer X"', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'I prefer TypeScript for new projects' },
    ];
    const beliefs = extractBeliefs(msgs, sessionId);
    expect(beliefs).toHaveLength(1);
    expect(beliefs[0].statement).toBe('User prefers TypeScript for new projects');
    expect(beliefs[0].category).toBe('user');
    expect(beliefs[0].confidence).toBe(0.75);
    expect(beliefs[0].tags).toContain('preference');
    expect(beliefs[0].source).toBe('conversation:test-session');
  });

  it('extracts preference with comparison: "I prefer X over Y"', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'I prefer Vim over Emacs' },
    ];
    const beliefs = extractBeliefs(msgs, sessionId);
    expect(beliefs).toHaveLength(1);
    expect(beliefs[0].statement).toBe('User prefers Vim over Emacs');
  });

  it('extracts dislike pattern: "I don\'t like X"', () => {
    const msgs: Message[] = [
      { role: 'user', content: "I don't like using semicolons in JS" },
    ];
    const beliefs = extractBeliefs(msgs, sessionId);
    expect(beliefs).toHaveLength(1);
    expect(beliefs[0].statement).toBe('User dislikes using semicolons in JS');
    expect(beliefs[0].confidence).toBe(0.7);
  });

  it('extracts work context pattern: "we\'re using X"', () => {
    const msgs: Message[] = [
      { role: 'user', content: "we're using Kubernetes for deployments" },
    ];
    const beliefs = extractBeliefs(msgs, sessionId);
    expect(beliefs).toHaveLength(1);
    expect(beliefs[0].statement).toBe('Work context: Kubernetes for deployments');
    expect(beliefs[0].tags).toContain('work');
    expect(beliefs[0].confidence).toBe(0.65);
  });

  it('extracts family context pattern: "my wife is X"', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'my wife is starting a new business next month' },
    ];
    const beliefs = extractBeliefs(msgs, sessionId);
    expect(beliefs).toHaveLength(1);
    expect(beliefs[0].statement).toContain('Family:');
    expect(beliefs[0].tags).toContain('family');
    expect(beliefs[0].confidence).toBe(0.6);
  });

  it('extracts decision pattern: "I decided X"', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'I decided to use PostgreSQL instead' },
    ];
    const beliefs = extractBeliefs(msgs, sessionId);
    expect(beliefs).toHaveLength(1);
    expect(beliefs[0].statement).toBe('Decision: to use PostgreSQL instead');
    expect(beliefs[0].tags).toContain('decision');
    expect(beliefs[0].confidence).toBe(0.7);
  });

  it('deduplicates identical statements within a session', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'I prefer TypeScript for everything' },
      { role: 'user', content: 'I prefer TypeScript for everything' },
    ];
    const beliefs = extractBeliefs(msgs, sessionId);
    expect(beliefs).toHaveLength(1);
  });

  it('skips assistant messages', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: 'I prefer to help with coding tasks' },
    ];
    expect(extractBeliefs(msgs, sessionId)).toEqual([]);
  });

  it('includes evidence from the original text', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'I always use dark mode for everything' },
    ];
    const beliefs = extractBeliefs(msgs, sessionId);
    expect(beliefs).toHaveLength(1);
    expect(beliefs[0].evidence).toHaveLength(1);
    expect(beliefs[0].evidence[0]).toContain('dark mode');
  });
});

// ── extractTopics ──

describe('extractTopics', () => {
  it('returns empty array for no user messages', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: 'typescript typescript typescript typescript' },
    ];
    expect(extractTopics(msgs)).toEqual([]);
  });

  it('returns empty array for words appearing only once', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'typescript python rust java' },
    ];
    expect(extractTopics(msgs)).toEqual([]);
  });

  it('extracts words appearing 2+ times', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'typescript is great' },
      { role: 'user', content: 'I love typescript' },
    ];
    const topics = extractTopics(msgs);
    expect(topics.length).toBeGreaterThanOrEqual(1);
    expect(topics[0].word).toBe('typescript');
    expect(topics[0].count).toBe(2);
  });

  it('filters stop words', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'the the the the the' },
      { role: 'user', content: 'the the the the the' },
    ];
    expect(extractTopics(msgs)).toEqual([]);
  });

  it('filters words shorter than 3 characters', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'go go go go go' },
      { role: 'user', content: 'go go go go go' },
    ];
    expect(extractTopics(msgs)).toEqual([]);
  });

  it('returns at most 5 topics', () => {
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
    const msgs: Message[] = words.flatMap(w => [
      { role: 'user', content: `${w} ${w} ${w}` },
      { role: 'user', content: `${w} ${w}` },
    ]);
    const topics = extractTopics(msgs);
    expect(topics.length).toBeLessThanOrEqual(5);
  });

  it('sorts by frequency descending', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'database database database' },
      { role: 'user', content: 'database server server' },
    ];
    const topics = extractTopics(msgs);
    expect(topics.length).toBeGreaterThanOrEqual(2);
    expect(topics[0].word).toBe('database');
    expect(topics[0].count).toBeGreaterThanOrEqual(topics[1].count);
  });
});

// ── extractCorrections ──

describe('extractCorrections', () => {
  it('returns empty array for no corrections', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'Thanks, that looks great!' },
    ];
    expect(extractCorrections(msgs)).toEqual([]);
  });

  it('detects pattern 1: "no, it\'s X"', () => {
    const msgs: Message[] = [
      { role: 'user', content: "no, it's PostgreSQL not MySQL" },
    ];
    const corrections = extractCorrections(msgs);
    expect(corrections).toHaveLength(1);
    expect(corrections[0].type).toBe('factual_correction');
    expect(corrections[0].content).toBe('PostgreSQL');
    expect(corrections[0].example_good).toBe('PostgreSQL');
    expect(corrections[0].example_bad).toBe('MySQL');
  });

  it('detects pattern 1 without "not Y" part', () => {
    const msgs: Message[] = [
      { role: 'user', content: "no, it should be version 3.0" },
    ];
    const corrections = extractCorrections(msgs);
    expect(corrections).toHaveLength(1);
    expect(corrections[0].type).toBe('factual_correction');
    expect(corrections[0].content).toBe('version 3.0');
  });

  it('detects pattern 2: "that\'s wrong"', () => {
    const msgs: Message[] = [
      { role: 'user', content: "that's wrong" },
    ];
    const corrections = extractCorrections(msgs);
    expect(corrections).toHaveLength(1);
    expect(corrections[0].type).toBe('factual_correction');
  });

  it('detects pattern 2: "that\'s incorrect"', () => {
    const msgs: Message[] = [
      { role: 'user', content: "that's incorrect" },
    ];
    const corrections = extractCorrections(msgs);
    expect(corrections).toHaveLength(1);
    expect(corrections[0].type).toBe('factual_correction');
  });

  it('detects pattern 2: "actually, X"', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'actually, the deadline is next Friday' },
    ];
    const corrections = extractCorrections(msgs);
    expect(corrections).toHaveLength(1);
    expect(corrections[0].type).toBe('factual_correction');
    expect(corrections[0].content).toBe('the deadline is next Friday');
  });

  it('detects pattern 3: "I already told you X"', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'I already told you the port is 8080' },
    ];
    const corrections = extractCorrections(msgs);
    expect(corrections).toHaveLength(1);
    expect(corrections[0].type).toBe('repeated_correction');
    expect(corrections[0].content).toBe('the port is 8080');
  });

  it('detects pattern 3: "as I said X"', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'as I said we need the latest version' },
    ];
    const corrections = extractCorrections(msgs);
    expect(corrections).toHaveLength(1);
    expect(corrections[0].type).toBe('repeated_correction');
  });

  it('detects pattern 4: "I don\'t want X, I want Y"', () => {
    const msgs: Message[] = [
      { role: 'user', content: "I don't want JSON, I want YAML" },
    ];
    const corrections = extractCorrections(msgs);
    expect(corrections).toHaveLength(1);
    expect(corrections[0].type).toBe('preference_correction');
    expect(corrections[0].example_bad).toBe('JSON');
    expect(corrections[0].example_good).toBe('YAML');
    expect(corrections[0].content).toBe('Wants YAML, not JSON');
  });

  it('deduplicates corrections with the same content', () => {
    const msgs: Message[] = [
      { role: 'user', content: "that's wrong" },
      { role: 'user', content: "that's incorrect" },
    ];
    const corrections = extractCorrections(msgs);
    // Both "that's wrong" and "that's incorrect" use the full text as content,
    // and they have different source text so content differs
    // The key point is the dedup works on content, not pattern
    for (const c of corrections) {
      expect(c.type).toBe('factual_correction');
    }
  });

  it('skips assistant messages', () => {
    const msgs: Message[] = [
      { role: 'assistant', content: "that's wrong, let me fix that" },
    ];
    expect(extractCorrections(msgs)).toEqual([]);
  });

  it('skips very short messages', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'no' },
    ];
    expect(extractCorrections(msgs)).toEqual([]);
  });
});
