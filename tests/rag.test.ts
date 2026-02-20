import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  initRag,
  chunkByParagraphs,
  chunkByHeading,
  chunkByLines,
  indexChunks,
  indexContent,
  removeSource,
  removeSourceType,
  search,
  searchHybrid,
  updateRelevanceScores,
  getStaleChunks,
  pruneStaleChunks,
  getIndexStats,
  getAccessStats,
} from '../src/rag.js';
import type { ChunkInput, HybridSearchOpts } from '../src/rag.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  initRag(db);
});

// ── initRag ──

describe('initRag', () => {
  it('creates the chunks table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chunks'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('creates the chunk_access table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chunk_access'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('creates the FTS5 virtual table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_fts'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('creates insert/delete/update triggers', () => {
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'chunks_%'")
      .all() as { name: string }[];
    const names = triggers.map(t => t.name).sort();
    expect(names).toEqual(['chunks_ad', 'chunks_ai', 'chunks_au']);
  });

  it('is idempotent', () => {
    initRag(db);
    initRag(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chunks'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('enables foreign keys', () => {
    const fk = db.pragma('foreign_keys') as { foreign_keys: number }[];
    expect(fk[0].foreign_keys).toBe(1);
  });
});

// ── Chunking Strategies ──

describe('chunkByParagraphs', () => {
  it('returns empty for empty/whitespace input', () => {
    expect(chunkByParagraphs('')).toEqual([]);
    expect(chunkByParagraphs('   ')).toEqual([]);
    expect(chunkByParagraphs('\n\n')).toEqual([]);
  });

  it('returns single chunk for short text', () => {
    const chunks = chunkByParagraphs('Hello world');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('Hello world');
    expect(chunks[0].chunk_index).toBe(0);
  });

  it('splits at paragraph boundaries', () => {
    const text = 'Paragraph one.\n\nParagraph two.\n\nParagraph three.';
    // maxLen=20 forces split: "Paragraph one." (14) + "\n\n" + "Paragraph two." (14) = 30 > 20
    const chunks = chunkByParagraphs(text, 20);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].content).toBe('Paragraph one.');
    expect(chunks[0].chunk_index).toBe(0);
    expect(chunks[1].content).toBe('Paragraph two.');
    expect(chunks[1].chunk_index).toBe(1);
    expect(chunks[2].content).toBe('Paragraph three.');
    expect(chunks[2].chunk_index).toBe(2);
  });

  it('merges short paragraphs under maxLen', () => {
    const text = 'A.\n\nB.\n\nC.';
    const chunks = chunkByParagraphs(text, 1500);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('A.\n\nB.\n\nC.');
  });

  it('respects maxLen parameter', () => {
    const text = 'Word '.repeat(100) + '\n\n' + 'More '.repeat(100);
    const chunks = chunkByParagraphs(text, 200);
    for (const c of chunks) {
      // Chunks should be close to maxLen but individual paragraphs may exceed it
      expect(c.chunk_index).toBeGreaterThanOrEqual(0);
    }
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('handles multiple consecutive blank lines', () => {
    const text = 'First.\n\n\n\nSecond.';
    const chunks = chunkByParagraphs(text, 10);
    expect(chunks.length).toBe(2);
    expect(chunks[0].content).toBe('First.');
    expect(chunks[1].content).toBe('Second.');
  });

  it('uses 1500 as default maxLen', () => {
    const longPara = 'x'.repeat(1000);
    const text = longPara + '\n\n' + longPara;
    const chunks = chunkByParagraphs(text);
    // 2000 chars total > 1500, so should split
    expect(chunks.length).toBe(2);
  });
});

describe('chunkByHeading', () => {
  it('returns empty for empty/whitespace input', () => {
    expect(chunkByHeading('')).toEqual([]);
    expect(chunkByHeading('   ')).toEqual([]);
  });

  it('returns single chunk for text without headings', () => {
    const chunks = chunkByHeading('Just some plain text.');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('Just some plain text.');
    expect(chunks[0].chunk_index).toBe(0);
  });

  it('splits at ## headings', () => {
    const text = '## Section A\nContent A\n## Section B\nContent B';
    const chunks = chunkByHeading(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].content).toContain('Section A');
    expect(chunks[1].content).toContain('Section B');
    expect(chunks[0].chunk_index).toBe(0);
    expect(chunks[1].chunk_index).toBe(1);
  });

  it('preserves preamble before first heading', () => {
    const text = 'Intro text\n## Section 1\nContent';
    const chunks = chunkByHeading(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].content).toBe('Intro text');
    expect(chunks[1].content).toContain('Section 1');
  });

  it('does not split at ### headings', () => {
    const text = '### Not a split point\nContent';
    const chunks = chunkByHeading(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain('### Not a split point');
  });
});

describe('chunkByLines', () => {
  it('returns empty for empty input', () => {
    expect(chunkByLines('')).toEqual([]);
  });

  it('returns empty for whitespace-only lines', () => {
    expect(chunkByLines('  \n  \n  ')).toEqual([]);
  });

  it('groups lines by groupSize', () => {
    const text = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join('\n');
    const chunks = chunkByLines(text, 8);
    expect(chunks).toHaveLength(3); // 8 + 8 + 4
    expect(chunks[0].chunk_index).toBe(0);
    expect(chunks[1].chunk_index).toBe(1);
    expect(chunks[2].chunk_index).toBe(2);
  });

  it('filters out empty lines by default', () => {
    const text = 'A\n\nB\n\nC';
    const chunks = chunkByLines(text, 10);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('A\nB\nC');
  });

  it('accepts custom line filter', () => {
    const text = '# comment\ndata1\n# comment\ndata2';
    const chunks = chunkByLines(text, 2, (l) => !l.startsWith('#'));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('data1\ndata2');
  });

  it('uses default groupSize of 8', () => {
    const text = Array.from({ length: 9 }, (_, i) => `L${i}`).join('\n');
    const chunks = chunkByLines(text);
    expect(chunks).toHaveLength(2); // 8 + 1
  });
});

// ── Indexing ──

describe('indexChunks', () => {
  it('inserts chunks into the database', () => {
    const chunks: ChunkInput[] = [
      { content: 'First chunk', chunk_index: 0 },
      { content: 'Second chunk', chunk_index: 1 },
    ];
    const count = indexChunks(db, 'doc', 'file1.md', chunks);
    expect(count).toBe(2);

    const stats = getIndexStats(db);
    expect(stats.total).toBe(2);
  });

  it('returns 0 for empty chunks array', () => {
    const count = indexChunks(db, 'doc', 'file1.md', []);
    expect(count).toBe(0);
  });

  it('replaces existing chunks for same source', () => {
    indexChunks(db, 'doc', 'file1.md', [
      { content: 'Old content', chunk_index: 0 },
    ]);
    indexChunks(db, 'doc', 'file1.md', [
      { content: 'New content', chunk_index: 0 },
      { content: 'Extra chunk', chunk_index: 1 },
    ]);

    const stats = getIndexStats(db);
    expect(stats.total).toBe(2);

    const results = search(db, 'New content');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toBe('New content');
  });

  it('stores metadata as JSON', () => {
    indexChunks(db, 'doc', 'file1.md', [
      { content: 'With metadata', chunk_index: 0, metadata: { author: 'test', page: 5 } },
    ]);
    const results = search(db, 'metadata');
    expect(results[0].metadata).toEqual({ author: 'test', page: 5 });
  });

  it('handles null metadata', () => {
    indexChunks(db, 'doc', 'file1.md', [
      { content: 'No metadata', chunk_index: 0 },
    ]);
    const results = search(db, 'metadata');
    expect(results[0].metadata).toEqual({});
  });

  it('does not affect chunks from other sources', () => {
    indexChunks(db, 'doc', 'file1.md', [{ content: 'File one', chunk_index: 0 }]);
    indexChunks(db, 'doc', 'file2.md', [{ content: 'File two', chunk_index: 0 }]);
    indexChunks(db, 'doc', 'file1.md', [{ content: 'File one updated', chunk_index: 0 }]);

    const stats = getIndexStats(db);
    expect(stats.total).toBe(2);
  });
});

describe('indexContent', () => {
  it('chunks with paragraphs strategy by default', () => {
    const text = 'Para one.\n\nPara two.';
    const count = indexContent(db, 'doc', 'test.md', text);
    expect(count).toBeGreaterThan(0);
  });

  it('chunks with headings strategy', () => {
    const text = '## Section A\nContent A\n## Section B\nContent B';
    const count = indexContent(db, 'doc', 'test.md', text, 'headings');
    expect(count).toBe(2);
  });

  it('chunks with lines strategy', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `Line ${i}`).join('\n');
    const count = indexContent(db, 'log', 'test.log', lines, 'lines', { groupSize: 5 });
    expect(count).toBe(2);
  });

  it('passes maxLen to paragraphs strategy', () => {
    const text = 'A'.repeat(50) + '\n\n' + 'B'.repeat(50);
    const count = indexContent(db, 'doc', 'test.md', text, 'paragraphs', { maxLen: 60 });
    expect(count).toBe(2);
  });
});

describe('removeSource', () => {
  it('removes chunks for a specific source', () => {
    indexChunks(db, 'doc', 'file1.md', [{ content: 'Content 1', chunk_index: 0 }]);
    indexChunks(db, 'doc', 'file2.md', [{ content: 'Content 2', chunk_index: 0 }]);

    const removed = removeSource(db, 'doc', 'file1.md');
    expect(removed).toBe(1);

    const stats = getIndexStats(db);
    expect(stats.total).toBe(1);
  });

  it('returns 0 for nonexistent source', () => {
    const removed = removeSource(db, 'doc', 'nonexistent.md');
    expect(removed).toBe(0);
  });
});

describe('removeSourceType', () => {
  it('removes all chunks of a source type', () => {
    indexChunks(db, 'doc', 'file1.md', [{ content: 'Doc 1', chunk_index: 0 }]);
    indexChunks(db, 'doc', 'file2.md', [{ content: 'Doc 2', chunk_index: 0 }]);
    indexChunks(db, 'log', 'app.log', [{ content: 'Log entry', chunk_index: 0 }]);

    const removed = removeSourceType(db, 'doc');
    expect(removed).toBe(2);

    const stats = getIndexStats(db);
    expect(stats.total).toBe(1);
    expect(stats.byType[0].source_type).toBe('log');
  });

  it('returns 0 for nonexistent type', () => {
    const removed = removeSourceType(db, 'nonexistent');
    expect(removed).toBe(0);
  });
});

// ── FTS5 Search ──

describe('search', () => {
  beforeEach(() => {
    indexChunks(db, 'doc', 'alpha.md', [
      { content: 'The quick brown fox jumps over the lazy dog', chunk_index: 0 },
      { content: 'Machine learning algorithms for natural language processing', chunk_index: 1 },
    ]);
    indexChunks(db, 'log', 'daily.log', [
      { content: 'Server started successfully on port 3000', chunk_index: 0 },
    ]);
    indexChunks(db, 'doc', 'beta.md', [
      { content: 'Advanced natural language understanding with transformers', chunk_index: 0 },
    ]);
  });

  it('finds matching content', () => {
    const results = search(db, 'natural language');
    expect(results.length).toBe(2);
    for (const r of results) {
      expect(r.content.toLowerCase()).toContain('natural language');
    }
  });

  it('returns SearchResult fields', () => {
    const results = search(db, 'quick brown fox');
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.id).toBeTypeOf('number');
    expect(r.source_type).toBe('doc');
    expect(r.source_file).toBe('alpha.md');
    expect(r.chunk_index).toBe(0);
    expect(r.content).toContain('quick brown fox');
    expect(r.rank).toBeTypeOf('number');
    expect(r.boosted_rank).toBeTypeOf('number');
    expect(r.relevance_score).toBeTypeOf('number');
    expect(r.access_count).toBeTypeOf('number');
    expect(r.created_at).toBeTruthy();
    expect(r.updated_at).toBeTruthy();
  });

  it('filters by sourceType', () => {
    const results = search(db, 'started', { sourceType: 'log' });
    expect(results).toHaveLength(1);
    expect(results[0].source_type).toBe('log');
  });

  it('respects limit', () => {
    const results = search(db, 'natural language', { limit: 1 });
    expect(results).toHaveLength(1);
  });

  it('returns empty for empty/sanitized-to-empty query', () => {
    expect(search(db, '')).toEqual([]);
    expect(search(db, '   ')).toEqual([]);
    expect(search(db, '***')).toEqual([]);
  });

  it('sanitizes special characters in query', () => {
    // Should not throw even with FTS5-breaking characters
    const results = search(db, "fox's {test} [bracket] (paren)");
    // May or may not find results, but should not throw
    expect(Array.isArray(results)).toBe(true);
  });

  it('records access count on search', () => {
    search(db, 'quick brown fox');
    search(db, 'quick brown fox');

    const access = db
      .prepare('SELECT access_count FROM chunk_access WHERE chunk_id = ?')
      .get(1) as { access_count: number } | undefined;
    expect(access).toBeDefined();
    expect(access!.access_count).toBe(2);
  });

  it('updates last_accessed on search', () => {
    search(db, 'quick brown fox');
    const access = db
      .prepare('SELECT last_accessed FROM chunk_access WHERE chunk_id = ?')
      .get(1) as { last_accessed: string };
    expect(access.last_accessed).toBeTruthy();
    expect(new Date(access.last_accessed).getTime()).toBeGreaterThan(0);
  });

  it('uses porter stemming (finds stemmed matches)', () => {
    indexChunks(db, 'doc', 'stem.md', [
      { content: 'The servers are running smoothly', chunk_index: 0 },
    ]);
    const results = search(db, 'server run');
    expect(results.length).toBeGreaterThan(0);
  });

  it('filters by dateAfter', () => {
    const futureDate = '2099-01-01T00:00:00.000Z';
    const results = search(db, 'fox', { dateAfter: futureDate });
    expect(results).toHaveLength(0);
  });

  it('filters by dateBefore', () => {
    const pastDate = '2000-01-01T00:00:00.000Z';
    const results = search(db, 'fox', { dateBefore: pastDate });
    expect(results).toHaveLength(0);
  });

  it('defaults limit to 10', () => {
    // Index many chunks
    const chunks: ChunkInput[] = Array.from({ length: 15 }, (_, i) => ({
      content: `Document about natural language processing number ${i}`,
      chunk_index: i,
    }));
    indexChunks(db, 'bulk', 'many.md', chunks);

    const results = search(db, 'natural language processing');
    expect(results.length).toBeLessThanOrEqual(10);
  });
});

// ── Hybrid Search ──

describe('searchHybrid', () => {
  beforeEach(() => {
    indexChunks(db, 'doc', 'hybrid.md', [
      { content: 'Neural networks for image classification', chunk_index: 0 },
      { content: 'Deep learning with convolutional architectures', chunk_index: 1 },
    ]);
  });

  it('falls back to FTS when chunk_vec table does not exist', async () => {
    const mockEmbed = async () => new Float32Array(384);
    const results = await searchHybrid(db, 'neural networks', {
      embedFn: mockEmbed,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].rrf_score).toBe(0); // FTS-only fallback sets rrf_score to 0
    expect(results[0].content).toContain('Neural networks');
  });

  it('passes sourceType filter through to FTS', async () => {
    indexChunks(db, 'log', 'other.log', [
      { content: 'Neural network training log', chunk_index: 0 },
    ]);

    const mockEmbed = async () => new Float32Array(384);
    const results = await searchHybrid(db, 'neural', {
      embedFn: mockEmbed,
      sourceType: 'doc',
    });
    for (const r of results) {
      expect(r.source_type).toBe('doc');
    }
  });

  it('respects limit', async () => {
    const mockEmbed = async () => new Float32Array(384);
    const results = await searchHybrid(db, 'neural deep learning', {
      embedFn: mockEmbed,
      limit: 1,
    });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('falls back gracefully when embedFn throws', async () => {
    // Create an empty chunk_vec table to trigger the embedFn path
    // Without sqlite-vec, this just tests the catch fallback
    const failingEmbed = async () => { throw new Error('embed failed'); };
    const results = await searchHybrid(db, 'neural networks', {
      embedFn: failingEmbed,
    });
    // Should still return FTS results
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].rrf_score).toBe(0);
  });
});

// ── Relevance Decay ──

describe('updateRelevanceScores', () => {
  it('creates chunk_access entries for all chunks', () => {
    indexChunks(db, 'doc', 'test.md', [
      { content: 'Chunk A', chunk_index: 0 },
      { content: 'Chunk B', chunk_index: 1 },
    ]);

    const result = updateRelevanceScores(db);
    expect(result.updated).toBe(2);

    const count = (db.prepare('SELECT COUNT(*) as cnt FROM chunk_access').get() as { cnt: number }).cnt;
    expect(count).toBe(2);
  });

  it('assigns scores close to 1.0 for fresh content', () => {
    indexChunks(db, 'doc', 'test.md', [
      { content: 'Fresh content', chunk_index: 0 },
    ]);

    updateRelevanceScores(db);

    const access = db
      .prepare('SELECT relevance_score FROM chunk_access')
      .get() as { relevance_score: number };
    // Just created, so timeDecay ~1.0, accessBoost ~1.0 → score ~1.0
    expect(access.relevance_score).toBeGreaterThan(0.9);
    expect(access.relevance_score).toBeLessThanOrEqual(2.0);
  });

  it('decays old content', () => {
    // Insert a chunk with old created_at
    const oldDate = '2020-01-01T00:00:00.000Z';
    db.prepare(`
      INSERT INTO chunks (source_type, source_file, chunk_index, content, created_at, updated_at)
      VALUES ('doc', 'old.md', 0, 'Old content', ?, ?)
    `).run(oldDate, oldDate);

    updateRelevanceScores(db);

    const access = db
      .prepare('SELECT relevance_score FROM chunk_access')
      .get() as { relevance_score: number };
    // ~6 years old with 90-day half-life → very decayed
    expect(access.relevance_score).toBeLessThan(0.1);
  });

  it('boosts frequently accessed content', () => {
    indexChunks(db, 'doc', 'test.md', [
      { content: 'Popular content', chunk_index: 0 },
      { content: 'Unpopular content', chunk_index: 1 },
    ]);

    // Simulate many accesses on the first chunk
    const chunkId = (db.prepare("SELECT id FROM chunks WHERE content = 'Popular content'").get() as { id: number }).id;
    db.prepare(`
      INSERT INTO chunk_access (chunk_id, access_count, last_accessed, relevance_score)
      VALUES (?, 50, datetime('now'), 1.0)
    `).run(chunkId);

    updateRelevanceScores(db);

    const popular = db
      .prepare('SELECT relevance_score FROM chunk_access WHERE chunk_id = ?')
      .get(chunkId) as { relevance_score: number };
    const unpopularId = (db.prepare("SELECT id FROM chunks WHERE content = 'Unpopular content'").get() as { id: number }).id;
    const unpopular = db
      .prepare('SELECT relevance_score FROM chunk_access WHERE chunk_id = ?')
      .get(unpopularId) as { relevance_score: number };

    expect(popular.relevance_score).toBeGreaterThan(unpopular.relevance_score);
  });

  it('caps access boost at maxAccessBoost', () => {
    indexChunks(db, 'doc', 'test.md', [
      { content: 'Super popular', chunk_index: 0 },
    ]);
    const chunkId = (db.prepare('SELECT id FROM chunks').get() as { id: number }).id;
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO chunk_access (chunk_id, access_count, last_accessed, relevance_score)
      VALUES (?, 10000, ?, 1.0)
    `).run(chunkId, now);

    updateRelevanceScores(db, { maxAccessBoost: 2.0 });

    const access = db
      .prepare('SELECT relevance_score FROM chunk_access WHERE chunk_id = ?')
      .get(chunkId) as { relevance_score: number };
    // Score = accessBoost * timeDecay. accessBoost capped at 2.0, timeDecay ~1.0
    expect(access.relevance_score).toBeGreaterThanOrEqual(1.9);
    expect(access.relevance_score).toBeLessThanOrEqual(2.1);
  });

  it('respects custom half-life config', () => {
    const oldDate = '2024-01-01T00:00:00.000Z';
    db.prepare(`
      INSERT INTO chunks (source_type, source_file, chunk_index, content, created_at, updated_at)
      VALUES ('doc', 'old.md', 0, 'Content', ?, ?)
    `).run(oldDate, oldDate);

    // With a very long half-life, even old content should retain score
    updateRelevanceScores(db, { creationHalfLife: 36500 }); // 100 years
    const longHL = db
      .prepare('SELECT relevance_score FROM chunk_access')
      .get() as { relevance_score: number };

    // Reset and try with short half-life
    db.prepare('DELETE FROM chunk_access').run();
    updateRelevanceScores(db, { creationHalfLife: 1 }); // 1 day
    const shortHL = db
      .prepare('SELECT relevance_score FROM chunk_access')
      .get() as { relevance_score: number };

    expect(longHL.relevance_score).toBeGreaterThan(shortHL.relevance_score);
  });

  it('returns updated count of 0 for empty database', () => {
    const result = updateRelevanceScores(db);
    expect(result.updated).toBe(0);
  });
});

// ── Stale Content Management ──

describe('getStaleChunks', () => {
  it('returns chunks below threshold', () => {
    // Insert old content with low relevance
    db.prepare(`
      INSERT INTO chunks (source_type, source_file, chunk_index, content, created_at, updated_at)
      VALUES ('doc', 'old.md', 0, 'Stale content', '2020-01-01', '2020-01-01')
    `).run();
    const chunkId = (db.prepare('SELECT id FROM chunks').get() as { id: number }).id;
    db.prepare(`
      INSERT INTO chunk_access (chunk_id, access_count, last_accessed, relevance_score)
      VALUES (?, 0, NULL, 0.05)
    `).run(chunkId);

    const stale = getStaleChunks(db, 20, 0.1);
    expect(stale).toHaveLength(1);
    expect(stale[0].relevance_score).toBe(0.05);
  });

  it('respects limit', () => {
    for (let i = 0; i < 5; i++) {
      db.prepare(`
        INSERT INTO chunks (source_type, source_file, chunk_index, content, created_at, updated_at)
        VALUES ('doc', 'old${i}.md', 0, 'Stale ${i}', '2020-01-01', '2020-01-01')
      `).run();
    }
    // Set all to very low relevance
    const ids = db.prepare('SELECT id FROM chunks').all() as { id: number }[];
    for (const { id } of ids) {
      db.prepare(`
        INSERT INTO chunk_access (chunk_id, access_count, relevance_score)
        VALUES (?, 0, 0.01)
      `).run(id);
    }

    const stale = getStaleChunks(db, 3, 0.1);
    expect(stale).toHaveLength(3);
  });

  it('truncates content to 200 chars', () => {
    const longContent = 'x'.repeat(300);
    db.prepare(`
      INSERT INTO chunks (source_type, source_file, chunk_index, content, created_at, updated_at)
      VALUES ('doc', 'long.md', 0, ?, '2020-01-01', '2020-01-01')
    `).run(longContent);
    const chunkId = (db.prepare('SELECT id FROM chunks').get() as { id: number }).id;
    db.prepare(`
      INSERT INTO chunk_access (chunk_id, access_count, relevance_score)
      VALUES (?, 0, 0.01)
    `).run(chunkId);

    const stale = getStaleChunks(db, 20, 0.1);
    expect(stale[0].content.length).toBe(203); // 200 + '...'
    expect(stale[0].content.endsWith('...')).toBe(true);
  });

  it('returns empty when no stale chunks exist', () => {
    indexChunks(db, 'doc', 'fresh.md', [{ content: 'Fresh', chunk_index: 0 }]);
    // Default relevance_score is 0.5 via COALESCE, threshold is 0.1
    const stale = getStaleChunks(db);
    expect(stale).toHaveLength(0);
  });

  it('orders by relevance_score ascending', () => {
    for (let i = 1; i <= 3; i++) {
      db.prepare(`
        INSERT INTO chunks (source_type, source_file, chunk_index, content, created_at, updated_at)
        VALUES ('doc', 'f${i}.md', 0, 'Content ${i}', '2020-01-01', '2020-01-01')
      `).run();
    }
    const ids = db.prepare('SELECT id FROM chunks ORDER BY id').all() as { id: number }[];
    db.prepare('INSERT INTO chunk_access (chunk_id, access_count, relevance_score) VALUES (?, 0, 0.09)').run(ids[0].id);
    db.prepare('INSERT INTO chunk_access (chunk_id, access_count, relevance_score) VALUES (?, 0, 0.03)').run(ids[1].id);
    db.prepare('INSERT INTO chunk_access (chunk_id, access_count, relevance_score) VALUES (?, 0, 0.06)').run(ids[2].id);

    const stale = getStaleChunks(db, 20, 0.1);
    expect(stale[0].relevance_score).toBe(0.03);
    expect(stale[1].relevance_score).toBe(0.06);
    expect(stale[2].relevance_score).toBe(0.09);
  });
});

describe('pruneStaleChunks', () => {
  function seedStale() {
    for (let i = 0; i < 3; i++) {
      db.prepare(`
        INSERT INTO chunks (source_type, source_file, chunk_index, content, created_at, updated_at)
        VALUES ('log', 'old${i}.log', 0, 'Old log ${i}', '2020-01-01', '2020-01-01')
      `).run();
    }
    db.prepare(`
      INSERT INTO chunks (source_type, source_file, chunk_index, content, created_at, updated_at)
      VALUES ('doc', 'keep.md', 0, 'Keep this', '2020-01-01', '2020-01-01')
    `).run();

    const ids = db.prepare('SELECT id, source_type FROM chunks').all() as { id: number; source_type: string }[];
    for (const { id } of ids) {
      db.prepare('INSERT INTO chunk_access (chunk_id, access_count, relevance_score) VALUES (?, 0, 0.01)').run(id);
    }
  }

  it('deletes chunks below threshold', () => {
    seedStale();
    const result = pruneStaleChunks(db, 0.05);
    expect(result.pruned).toBe(4);
    expect(getIndexStats(db).total).toBe(0);
  });

  it('supports dryRun mode', () => {
    seedStale();
    const result = pruneStaleChunks(db, 0.05, { dryRun: true });
    expect(result.pruned).toBe(4);
    expect(result.dryRun).toBe(true);
    // Nothing actually deleted
    expect(getIndexStats(db).total).toBe(4);
  });

  it('filters by prunableTypes', () => {
    seedStale();
    const result = pruneStaleChunks(db, 0.05, { prunableTypes: ['log'] });
    expect(result.pruned).toBe(3);
    expect(result.byType).toEqual({ log: 3 });
    // doc chunk should remain
    expect(getIndexStats(db).total).toBe(1);
  });

  it('returns byType breakdown', () => {
    seedStale();
    const result = pruneStaleChunks(db, 0.05);
    expect(result.byType.log).toBe(3);
    expect(result.byType.doc).toBe(1);
  });

  it('returns 0 pruned when nothing is stale', () => {
    indexChunks(db, 'doc', 'fresh.md', [{ content: 'Fresh', chunk_index: 0 }]);
    // Relevance defaults to 0.5 via COALESCE, threshold is 0.05
    const result = pruneStaleChunks(db);
    expect(result.pruned).toBe(0);
  });
});

// ── Statistics ──

describe('getIndexStats', () => {
  it('returns 0 for empty database', () => {
    const stats = getIndexStats(db);
    expect(stats.total).toBe(0);
    expect(stats.byType).toEqual([]);
  });

  it('counts total chunks', () => {
    indexChunks(db, 'doc', 'a.md', [
      { content: 'A', chunk_index: 0 },
      { content: 'B', chunk_index: 1 },
    ]);
    indexChunks(db, 'log', 'b.log', [
      { content: 'C', chunk_index: 0 },
    ]);

    const stats = getIndexStats(db);
    expect(stats.total).toBe(3);
  });

  it('breaks down by source type', () => {
    indexChunks(db, 'doc', 'a.md', [{ content: 'A', chunk_index: 0 }]);
    indexChunks(db, 'doc', 'b.md', [{ content: 'B', chunk_index: 0 }]);
    indexChunks(db, 'log', 'c.log', [{ content: 'C', chunk_index: 0 }]);

    const stats = getIndexStats(db);
    expect(stats.byType).toHaveLength(2);

    const docType = stats.byType.find(t => t.source_type === 'doc');
    const logType = stats.byType.find(t => t.source_type === 'log');
    expect(docType?.count).toBe(2);
    expect(logType?.count).toBe(1);
  });
});

describe('getAccessStats', () => {
  it('returns zeros for empty database', () => {
    const stats = getAccessStats(db);
    expect(stats.totalChunks).toBe(0);
    expect(stats.trackedChunks).toBe(0);
    expect(stats.accessedChunks).toBe(0);
    expect(stats.neverAccessed).toBe(0);
    expect(stats.avgRelevanceScore).toBeNull();
    expect(stats.belowDecayThreshold).toBe(0);
  });

  it('counts total and tracked chunks', () => {
    indexChunks(db, 'doc', 'a.md', [
      { content: 'Content A', chunk_index: 0 },
      { content: 'Content B', chunk_index: 1 },
    ]);

    // Search to create access records for one chunk
    search(db, 'Content A');

    const stats = getAccessStats(db);
    expect(stats.totalChunks).toBe(2);
    expect(stats.trackedChunks).toBe(1);
    expect(stats.accessedChunks).toBe(1);
    expect(stats.neverAccessed).toBe(1); // totalChunks - accessedChunks
  });

  it('calculates avgRelevanceScore', () => {
    indexChunks(db, 'doc', 'a.md', [
      { content: 'Chunk one', chunk_index: 0 },
      { content: 'Chunk two', chunk_index: 1 },
    ]);

    // Manually set relevance scores
    const ids = db.prepare('SELECT id FROM chunks ORDER BY id').all() as { id: number }[];
    db.prepare('INSERT INTO chunk_access (chunk_id, access_count, relevance_score) VALUES (?, 1, 0.8)').run(ids[0].id);
    db.prepare('INSERT INTO chunk_access (chunk_id, access_count, relevance_score) VALUES (?, 1, 0.4)').run(ids[1].id);

    const stats = getAccessStats(db);
    expect(stats.avgRelevanceScore).toBe(0.6);
  });

  it('counts belowDecayThreshold', () => {
    indexChunks(db, 'doc', 'a.md', [
      { content: 'Chunk one', chunk_index: 0 },
      { content: 'Chunk two', chunk_index: 1 },
    ]);
    const ids = db.prepare('SELECT id FROM chunks ORDER BY id').all() as { id: number }[];
    db.prepare('INSERT INTO chunk_access (chunk_id, access_count, relevance_score) VALUES (?, 0, 0.05)').run(ids[0].id);
    db.prepare('INSERT INTO chunk_access (chunk_id, access_count, relevance_score) VALUES (?, 1, 0.9)').run(ids[1].id);

    const stats = getAccessStats(db);
    expect(stats.belowDecayThreshold).toBe(1);
  });
});

// ── FTS5 Integration ──

describe('FTS5 sync triggers', () => {
  it('FTS index stays in sync after insert', () => {
    indexChunks(db, 'doc', 'test.md', [
      { content: 'Unique searchable content xyz123', chunk_index: 0 },
    ]);
    const results = search(db, 'xyz123');
    expect(results).toHaveLength(1);
  });

  it('FTS index stays in sync after delete', () => {
    indexChunks(db, 'doc', 'test.md', [
      { content: 'Deletable content abc789', chunk_index: 0 },
    ]);
    removeSource(db, 'doc', 'test.md');
    const results = search(db, 'abc789');
    expect(results).toHaveLength(0);
  });

  it('FTS index stays in sync after replace (update)', () => {
    indexChunks(db, 'doc', 'test.md', [
      { content: 'Original content oldterm', chunk_index: 0 },
    ]);
    indexChunks(db, 'doc', 'test.md', [
      { content: 'Replaced content newterm', chunk_index: 0 },
    ]);

    expect(search(db, 'oldterm')).toHaveLength(0);
    expect(search(db, 'newterm')).toHaveLength(1);
  });
});

// ── End-to-end workflow ──

describe('end-to-end workflow', () => {
  it('index → search → decay → prune lifecycle', () => {
    // 1. Index content
    indexContent(db, 'doc', 'guide.md', '## Setup\nInstall deps\n## Usage\nRun the app');
    indexContent(db, 'log', 'app.log', Array.from({ length: 16 }, (_, i) => `Log entry ${i}`).join('\n'), 'lines', { groupSize: 8 });

    const stats = getIndexStats(db);
    expect(stats.total).toBeGreaterThan(0);

    // 2. Search and verify results
    const results = search(db, 'Install');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain('Install');

    // 3. Decay scores
    const decay = updateRelevanceScores(db);
    expect(decay.updated).toBe(stats.total);

    // 4. Check access stats
    const accessStats = getAccessStats(db);
    expect(accessStats.totalChunks).toBe(stats.total);
    expect(accessStats.trackedChunks).toBe(stats.total); // decay creates entries for all

    // 5. No stale chunks (all fresh)
    const stale = getStaleChunks(db);
    expect(stale).toHaveLength(0);

    // 6. Prune does nothing
    const pruned = pruneStaleChunks(db);
    expect(pruned.pruned).toBe(0);
  });

  it('multiple source types coexist independently', () => {
    indexContent(db, 'doc', 'readme.md', 'Project documentation overview');
    indexContent(db, 'conversation', 'chat-001', 'Discussion about project setup');
    indexContent(db, 'log', 'deploy.log', 'Deployment succeeded at 10:00');

    const stats = getIndexStats(db);
    expect(stats.byType).toHaveLength(3);

    // Remove one type, others survive
    removeSourceType(db, 'log');
    const after = getIndexStats(db);
    expect(after.byType).toHaveLength(2);
    expect(after.byType.find(t => t.source_type === 'log')).toBeUndefined();
  });
});
