/**
 * F6 — Hybrid RAG Module for Vokari.
 *
 * SQLite FTS5 full-text search with:
 * - BM25 ranking with porter stemming
 * - Relevance decay (time since creation + time since access)
 * - Access count boosting (frequently retrieved content ranks higher)
 * - Configurable chunking strategies (paragraphs, headings, lines)
 * - Pluggable vector search with Reciprocal Rank Fusion (RRF)
 * - Stale content detection and pruning
 *
 * Generalized from Brain's rag.mjs. All Brain-specific source types,
 * filesystem I/O, and directory scanning removed. Users provide content
 * directly; Vokari handles chunking, indexing, search, and decay.
 *
 * Design principles:
 * - FTS5 is the workhorse. Vector search is opt-in enhancement.
 * - Relevance decay ensures old, unused content fades naturally.
 * - Chunking is pluggable — use built-in strategies or bring your own.
 * - All functions take explicit `db` parameter (no singletons).
 */

import type Database from 'better-sqlite3';

// ── Types ──

export interface ChunkInput {
  content: string;
  metadata?: Record<string, unknown>;
  chunk_index: number;
}

export interface Chunk {
  id: number;
  source_type: string;
  source_file: string;
  chunk_index: number;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SearchResult extends Chunk {
  rank: number;
  boosted_rank: number;
  relevance_score: number;
  access_count: number;
}

export interface HybridSearchResult extends SearchResult {
  rrf_score: number;
}

export interface SearchOpts {
  sourceType?: string;
  limit?: number;
  dateAfter?: string;
  dateBefore?: string;
}

export type EmbedFn = (text: string) => Promise<Float32Array>;

export interface HybridSearchOpts extends SearchOpts {
  embedFn: EmbedFn;
}

export interface RelevanceConfig {
  /** Half-life in days for access-based decay (default: 30). */
  accessHalfLife?: number;
  /** Half-life in days for creation-based decay (default: 90). */
  creationHalfLife?: number;
  /** Maximum access boost multiplier (default: 2.0). */
  maxAccessBoost?: number;
}

export interface PruneOpts {
  /** Only prune these source types. If empty, prunes all. */
  prunableTypes?: string[];
  /** Dry run — count without deleting. */
  dryRun?: boolean;
}

export interface IndexStats {
  total: number;
  byType: { source_type: string; count: number }[];
}

export interface AccessStats {
  totalChunks: number;
  trackedChunks: number;
  accessedChunks: number;
  neverAccessed: number;
  avgRelevanceScore: number | null;
  belowDecayThreshold: number;
}

export interface DecayResult {
  updated: number;
}

export interface PruneResult {
  pruned: number;
  byType: Record<string, number>;
  dryRun?: boolean;
}

export interface StaleChunk {
  id: number;
  source_type: string;
  source_file: string;
  content: string;
  created_at: string;
  relevance_score: number;
  access_count: number;
  last_accessed: string | null;
}

// ── Raw row types (pre-JSON parse) ──

interface ChunkRow {
  id: number;
  source_type: string;
  source_file: string;
  chunk_index: number;
  content: string;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

interface SearchRow extends ChunkRow {
  rank: number;
  boosted_rank: number;
  relevance_score: number | null;
  access_count: number | null;
}

interface CountRow {
  cnt: number;
}

interface AvgRow {
  avg: number | null;
}

interface TypeCountRow {
  source_type: string;
  count: number;
}

// ── Schema ──

const RAG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL,
    source_file TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_source
    ON chunks(source_type, source_file, chunk_index);

  CREATE INDEX IF NOT EXISTS idx_chunks_created
    ON chunks(created_at);

  CREATE INDEX IF NOT EXISTS idx_chunks_source_type
    ON chunks(source_type);

  CREATE TABLE IF NOT EXISTS chunk_access (
    chunk_id INTEGER PRIMARY KEY,
    access_count INTEGER NOT NULL DEFAULT 0,
    last_accessed TEXT,
    relevance_score REAL NOT NULL DEFAULT 1.0,
    FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
  );
`;

/**
 * Initialize the RAG tables, FTS5 index, and triggers.
 * Safe to call multiple times — uses IF NOT EXISTS.
 */
export function initRag(db: Database.Database): void {
  db.pragma('foreign_keys = ON');
  db.exec(RAG_SCHEMA);

  // FTS5 virtual table — external content mode (references chunks table)
  const ftsExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_fts'"
  ).get();

  if (!ftsExists) {
    db.exec(`
      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        content,
        source_type,
        metadata,
        content=chunks,
        content_rowid=id,
        tokenize='porter unicode61'
      );

      CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, content, source_type, metadata)
          VALUES (new.id, new.content, new.source_type, new.metadata);
      END;

      CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, content, source_type, metadata)
          VALUES ('delete', old.id, old.content, old.source_type, old.metadata);
      END;

      CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, content, source_type, metadata)
          VALUES ('delete', old.id, old.content, old.source_type, old.metadata);
        INSERT INTO chunks_fts(rowid, content, source_type, metadata)
          VALUES (new.id, new.content, new.source_type, new.metadata);
      END;
    `);
  }
}

// ── Chunking Strategies ──

/**
 * Split text at paragraph boundaries (\n\n), keeping chunks under maxLen.
 * General-purpose chunking for prose, markdown, logs.
 */
export function chunkByParagraphs(text: string, maxLen: number = 1500): ChunkInput[] {
  if (!text.trim()) return [];
  if (text.length <= maxLen) return [{ content: text.trim(), chunk_index: 0 }];

  const paragraphs = text.split(/\n\n+/);
  const chunks: ChunkInput[] = [];
  let current = '';
  let idx = 0;

  for (const p of paragraphs) {
    if (current.length + p.length + 2 > maxLen && current) {
      chunks.push({ content: current.trim(), chunk_index: idx++ });
      current = '';
    }
    current += (current ? '\n\n' : '') + p;
  }
  if (current.trim()) {
    chunks.push({ content: current.trim(), chunk_index: idx });
  }

  return chunks;
}

/**
 * Split markdown text at ## headings. Each section becomes a chunk.
 * Good for structured documents, context files, documentation.
 */
export function chunkByHeading(text: string): ChunkInput[] {
  if (!text.trim()) return [];

  const sections = text.split(/(?=^## )/m).filter(s => s.trim());
  if (sections.length === 0) {
    return [{ content: text.trim(), chunk_index: 0 }];
  }

  return sections.map((section, i) => ({
    content: section.trim(),
    chunk_index: i,
  }));
}

/**
 * Group non-empty lines into chunks of `groupSize`.
 * Good for log files, bullet-point lists, daily entries.
 *
 * @param text - Raw text content
 * @param groupSize - Number of lines per chunk (default: 8)
 * @param lineFilter - Optional filter for which lines to include (default: non-empty)
 */
export function chunkByLines(
  text: string,
  groupSize: number = 8,
  lineFilter?: (line: string) => boolean,
): ChunkInput[] {
  const filter = lineFilter ?? ((l: string) => l.trim().length > 0);
  const lines = text.split('\n').filter(filter);

  if (lines.length === 0) return [];

  const chunks: ChunkInput[] = [];
  for (let i = 0; i < lines.length; i += groupSize) {
    const slice = lines.slice(i, i + groupSize);
    chunks.push({
      content: slice.join('\n'),
      chunk_index: Math.floor(i / groupSize),
    });
  }

  return chunks;
}

// ── Indexing ──

/**
 * Index content by chunking it and inserting into the database.
 * Replaces any existing chunks for this source.
 *
 * @param db - Database connection
 * @param sourceType - Category label (e.g., 'document', 'conversation', 'log')
 * @param sourceFile - Unique identifier within the source type
 * @param chunks - Pre-chunked content (use chunkBy* helpers or bring your own)
 */
export function indexChunks(
  db: Database.Database,
  sourceType: string,
  sourceFile: string,
  chunks: ChunkInput[],
): number {
  if (chunks.length === 0) return 0;

  const now = new Date().toISOString();

  const txn = db.transaction(() => {
    // Remove existing chunks for this source
    db.prepare('DELETE FROM chunks WHERE source_type = ? AND source_file = ?')
      .run(sourceType, sourceFile);

    // Insert new chunks
    const stmt = db.prepare(`
      INSERT INTO chunks (source_type, source_file, chunk_index, content, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const chunk of chunks) {
      stmt.run(
        sourceType,
        sourceFile,
        chunk.chunk_index,
        chunk.content,
        chunk.metadata ? JSON.stringify(chunk.metadata) : null,
        now,
        now,
      );
    }
  });

  txn();
  return chunks.length;
}

/**
 * Convenience: chunk text with a strategy and index in one call.
 *
 * @param db - Database connection
 * @param sourceType - Category label
 * @param sourceFile - Unique identifier
 * @param text - Raw text to chunk and index
 * @param strategy - 'paragraphs' | 'headings' | 'lines' (default: 'paragraphs')
 * @param strategyOpts - Options for the chunking strategy
 */
export function indexContent(
  db: Database.Database,
  sourceType: string,
  sourceFile: string,
  text: string,
  strategy: 'paragraphs' | 'headings' | 'lines' = 'paragraphs',
  strategyOpts?: { maxLen?: number; groupSize?: number },
): number {
  let chunks: ChunkInput[];

  switch (strategy) {
    case 'headings':
      chunks = chunkByHeading(text);
      break;
    case 'lines':
      chunks = chunkByLines(text, strategyOpts?.groupSize ?? 8);
      break;
    case 'paragraphs':
    default:
      chunks = chunkByParagraphs(text, strategyOpts?.maxLen ?? 1500);
      break;
  }

  return indexChunks(db, sourceType, sourceFile, chunks);
}

/**
 * Remove all chunks for a source.
 */
export function removeSource(
  db: Database.Database,
  sourceType: string,
  sourceFile: string,
): number {
  const result = db.prepare(
    'DELETE FROM chunks WHERE source_type = ? AND source_file = ?'
  ).run(sourceType, sourceFile);
  return result.changes;
}

/**
 * Remove all chunks for a source type.
 */
export function removeSourceType(db: Database.Database, sourceType: string): number {
  const result = db.prepare('DELETE FROM chunks WHERE source_type = ?').run(sourceType);
  return result.changes;
}

// ── FTS5 Search ──

/**
 * Search the RAG index using FTS5 BM25 ranking.
 * Results are boosted by relevance_score (from decay tracking).
 *
 * @param db - Database connection
 * @param queryText - Search terms (natural language)
 * @param opts - Filtering options
 */
export function search(
  db: Database.Database,
  queryText: string,
  opts: SearchOpts = {},
): SearchResult[] {
  const { sourceType, limit = 10, dateAfter, dateBefore } = opts;

  // Sanitize query for FTS5 — remove special characters that break MATCH syntax
  const sanitized = queryText
    .replace(/['"]/g, '')
    .replace(/[{}()\[\]^~*:]/g, ' ')
    .trim();

  if (!sanitized) return [];

  let sql = `
    SELECT c.id, c.content, c.source_type, c.source_file, c.chunk_index,
           c.metadata, c.created_at, c.updated_at,
           rank,
           COALESCE(ca.relevance_score, 0.5) AS relevance_score,
           COALESCE(ca.access_count, 0) AS access_count,
           rank * COALESCE(ca.relevance_score, 0.5) AS boosted_rank
    FROM chunks_fts
    JOIN chunks c ON chunks_fts.rowid = c.id
    LEFT JOIN chunk_access ca ON ca.chunk_id = c.id
    WHERE chunks_fts MATCH ?
  `;
  const params: (string | number)[] = [sanitized];

  if (sourceType) {
    sql += ` AND c.source_type = ?`;
    params.push(sourceType);
  }
  if (dateAfter) {
    sql += ` AND c.created_at >= ?`;
    params.push(dateAfter);
  }
  if (dateBefore) {
    sql += ` AND c.created_at <= ?`;
    params.push(dateBefore);
  }

  // BM25 rank is negative (lower = better), so boosted_rank is also negative.
  // Multiply by relevance_score (0-2) makes more-relevant chunks rank higher.
  sql += ` ORDER BY boosted_rank ASC LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as SearchRow[];

  // Record access for returned results
  if (rows.length > 0) {
    const now = new Date().toISOString();
    const accessStmt = db.prepare(`
      INSERT INTO chunk_access (chunk_id, access_count, last_accessed, relevance_score)
      VALUES (?, 1, ?, 1.0)
      ON CONFLICT(chunk_id) DO UPDATE SET
        access_count = access_count + 1,
        last_accessed = ?
    `);
    for (const r of rows) {
      accessStmt.run(r.id, now, now);
    }
  }

  return rows.map(rowToSearchResult);
}

// ── Hybrid Search (FTS5 + Vector via RRF) ──

/**
 * Hybrid search combining FTS5 keyword search with vector semantic search.
 * Uses Reciprocal Rank Fusion (RRF) to merge the two ranked lists.
 *
 * Requires:
 * - sqlite-vec extension loaded on the database
 * - A `chunk_vec` virtual table: CREATE VIRTUAL TABLE chunk_vec USING vec0(embedding float[N])
 * - Embeddings pre-generated for indexed chunks
 * - An embed function that produces vectors matching the table dimension
 *
 * Falls back to FTS5-only if vector search fails for any reason.
 *
 * @param db - Database connection (with sqlite-vec loaded)
 * @param queryText - Search query
 * @param opts - Search options including the embed function
 */
export async function searchHybrid(
  db: Database.Database,
  queryText: string,
  opts: HybridSearchOpts,
): Promise<HybridSearchResult[]> {
  const { embedFn, limit = 10, ...searchOpts } = opts;

  // Step 1: FTS5 keyword search (always available)
  const ftsResults = search(db, queryText, { ...searchOpts, limit: limit * 2 });

  // Step 2: Vector search
  let vecResults: { rowid: number; distance: number }[] = [];
  try {
    // Check if vec table exists
    const vecExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='chunk_vec'"
    ).get();
    if (!vecExists) {
      return ftsResults.map(r => ({ ...r, rrf_score: 0 }));
    }

    const vecCount = (db.prepare('SELECT COUNT(*) as cnt FROM chunk_vec').get() as CountRow).cnt;
    if (vecCount === 0) {
      return ftsResults.map(r => ({ ...r, rrf_score: 0 }));
    }

    const queryEmbedding = await embedFn(queryText);
    vecResults = db.prepare(`
      SELECT rowid, distance FROM chunk_vec
      WHERE embedding MATCH ? AND k = ?
      ORDER BY distance
    `).all(Buffer.from(queryEmbedding.buffer), limit * 2) as { rowid: number; distance: number }[];
  } catch {
    // Vector search failed — return FTS-only results
    return ftsResults.map(r => ({ ...r, rrf_score: 0 }));
  }

  if (vecResults.length === 0) {
    return ftsResults.map(r => ({ ...r, rrf_score: 0 }));
  }

  // Step 3: Reciprocal Rank Fusion
  const K = 60; // Standard RRF constant from the literature
  const scores = new Map<number, { result: SearchResult; ftsRRF: number; vecRRF: number }>();

  // FTS scores by position
  ftsResults.forEach((r, i) => {
    scores.set(r.id, { result: r, ftsRRF: 1.0 / (K + i + 1), vecRRF: 0 });
  });

  // Vec scores by position — need to hydrate chunk data
  const vecIds = vecResults.map(r => r.rowid);
  if (vecIds.length > 0) {
    const placeholders = vecIds.map(() => '?').join(',');
    let sql = `
      SELECT c.id, c.content, c.source_type, c.source_file, c.chunk_index,
             c.metadata, c.created_at, c.updated_at,
             0 AS rank,
             COALESCE(ca.relevance_score, 0.5) AS relevance_score,
             COALESCE(ca.access_count, 0) AS access_count,
             0 AS boosted_rank
      FROM chunks c
      LEFT JOIN chunk_access ca ON ca.chunk_id = c.id
      WHERE c.id IN (${placeholders})
    `;
    const params: unknown[] = [...vecIds];

    if (searchOpts.sourceType) {
      sql += ` AND c.source_type = ?`;
      params.push(searchOpts.sourceType);
    }

    const chunkMap = new Map<number, SearchResult>();
    const rows = db.prepare(sql).all(...params) as SearchRow[];
    for (const row of rows) {
      chunkMap.set(row.id, rowToSearchResult(row));
    }

    vecResults.forEach((vr, i) => {
      const chunk = chunkMap.get(vr.rowid);
      if (!chunk) return;
      const rrf = 1.0 / (K + i + 1);
      if (scores.has(chunk.id)) {
        scores.get(chunk.id)!.vecRRF = rrf;
      } else {
        scores.set(chunk.id, { result: chunk, ftsRRF: 0, vecRRF: rrf });
      }
    });
  }

  // Combine and sort by total RRF score
  return [...scores.values()]
    .map(s => ({
      ...s.result,
      rrf_score: Math.round((s.ftsRRF + s.vecRRF) * 10000) / 10000,
    }))
    .sort((a, b) => b.rrf_score - a.rrf_score)
    .slice(0, limit);
}

// ── Relevance Decay ──

/**
 * Recalculate relevance scores for all chunks.
 *
 * Formula:
 *   relevance = accessBoost * timeDecay
 *   accessBoost = min(maxBoost, 1.0 + log2(access_count + 1) * 0.3)
 *   timeDecay = max(0.5^(daysSinceAccess/accessHL), 0.5^(daysSinceCreation/creationHL))
 *
 * - Recently accessed content stays relevant longer.
 * - Frequently accessed content gets a boost (capped).
 * - Never-accessed content decays based on creation age.
 * - The max() in timeDecay means whichever is fresher (access or creation) wins.
 */
export function updateRelevanceScores(
  db: Database.Database,
  config?: RelevanceConfig,
): DecayResult {
  const accessHL = config?.accessHalfLife ?? 30;
  const creationHL = config?.creationHalfLife ?? 90;
  const maxBoost = config?.maxAccessBoost ?? 2.0;
  const now = Date.now();

  const chunks = db.prepare(`
    SELECT c.id, c.created_at,
           COALESCE(ca.access_count, 0) as access_count,
           ca.last_accessed
    FROM chunks c
    LEFT JOIN chunk_access ca ON ca.chunk_id = c.id
  `).all() as {
    id: number;
    created_at: string;
    access_count: number;
    last_accessed: string | null;
  }[];

  const upsertStmt = db.prepare(`
    INSERT INTO chunk_access (chunk_id, access_count, last_accessed, relevance_score)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(chunk_id) DO UPDATE SET relevance_score = ?
  `);

  let updated = 0;

  const txn = db.transaction(() => {
    for (const chunk of chunks) {
      const createdAt = new Date(chunk.created_at).getTime();
      const lastAccessed = chunk.last_accessed
        ? new Date(chunk.last_accessed).getTime()
        : createdAt;

      const daysSinceCreation = (now - createdAt) / (1000 * 60 * 60 * 24);
      const daysSinceAccess = (now - lastAccessed) / (1000 * 60 * 60 * 24);

      // Access boost: log-scaled, capped
      const accessBoost = Math.min(maxBoost, 1.0 + Math.log2(chunk.access_count + 1) * 0.3);

      // Time decay: use whichever is fresher
      const accessDecay = Math.pow(0.5, daysSinceAccess / accessHL);
      const creationDecay = Math.pow(0.5, daysSinceCreation / creationHL);
      const timeDecay = Math.max(accessDecay, creationDecay);

      const score = Math.round(accessBoost * timeDecay * 1000) / 1000;

      upsertStmt.run(
        chunk.id,
        chunk.access_count,
        chunk.last_accessed,
        score,
        score,
      );
      updated++;
    }
  });

  txn();
  return { updated };
}

// ── Stale Content Management ──

/**
 * Get chunks with lowest relevance scores.
 */
export function getStaleChunks(
  db: Database.Database,
  limit: number = 20,
  threshold: number = 0.1,
): StaleChunk[] {
  return db.prepare(`
    SELECT c.id, c.source_type, c.source_file, c.content,
           c.created_at, COALESCE(ca.relevance_score, 0.5) as relevance_score,
           COALESCE(ca.access_count, 0) as access_count,
           ca.last_accessed
    FROM chunks c
    LEFT JOIN chunk_access ca ON ca.chunk_id = c.id
    WHERE COALESCE(ca.relevance_score, 0.5) < ?
    ORDER BY COALESCE(ca.relevance_score, 0.5) ASC
    LIMIT ?
  `).all(threshold, limit).map((row: unknown) => {
    const r = row as StaleChunk & { content: string };
    return {
      ...r,
      content: r.content.slice(0, 200) + (r.content.length > 200 ? '...' : ''),
    };
  });
}

/**
 * Prune chunks below a relevance threshold.
 * By default only prunes specified source types — never prunes unless told to.
 */
export function pruneStaleChunks(
  db: Database.Database,
  threshold: number = 0.05,
  opts?: PruneOpts,
): PruneResult {
  const prunableTypes = opts?.prunableTypes;
  const dryRun = opts?.dryRun ?? false;

  let sql = `
    SELECT c.id, c.source_type
    FROM chunks c
    LEFT JOIN chunk_access ca ON ca.chunk_id = c.id
    WHERE COALESCE(ca.relevance_score, 0.5) < ?
  `;
  const params: unknown[] = [threshold];

  if (prunableTypes && prunableTypes.length > 0) {
    sql += ` AND c.source_type IN (${prunableTypes.map(() => '?').join(',')})`;
    params.push(...prunableTypes);
  }

  const candidates = db.prepare(sql).all(...params) as { id: number; source_type: string }[];

  const byType: Record<string, number> = {};
  for (const c of candidates) {
    byType[c.source_type] = (byType[c.source_type] || 0) + 1;
  }

  if (dryRun) {
    return { pruned: candidates.length, byType, dryRun: true };
  }

  const deleteStmt = db.prepare('DELETE FROM chunks WHERE id = ?');
  const txn = db.transaction(() => {
    for (const c of candidates) {
      deleteStmt.run(c.id);
    }
  });
  txn();

  return { pruned: candidates.length, byType };
}

// ── Statistics ──

/**
 * Get index statistics — total chunks and breakdown by source type.
 */
export function getIndexStats(db: Database.Database): IndexStats {
  const total = (db.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as CountRow).cnt;
  const byType = db.prepare(
    'SELECT source_type, COUNT(*) as count FROM chunks GROUP BY source_type'
  ).all() as TypeCountRow[];

  return { total, byType };
}

/**
 * Get access tracking statistics.
 */
export function getAccessStats(db: Database.Database): AccessStats {
  const totalChunks = (db.prepare('SELECT COUNT(*) as cnt FROM chunks').get() as CountRow).cnt;
  const trackedChunks = (db.prepare('SELECT COUNT(*) as cnt FROM chunk_access').get() as CountRow).cnt;
  const accessedChunks = (db.prepare(
    'SELECT COUNT(*) as cnt FROM chunk_access WHERE access_count > 0'
  ).get() as CountRow).cnt;
  const avgScore = (db.prepare(
    'SELECT AVG(relevance_score) as avg FROM chunk_access'
  ).get() as AvgRow).avg;
  const belowThreshold = (db.prepare(
    'SELECT COUNT(*) as cnt FROM chunk_access WHERE relevance_score < 0.1'
  ).get() as CountRow).cnt;

  return {
    totalChunks,
    trackedChunks,
    accessedChunks,
    neverAccessed: totalChunks - accessedChunks,
    avgRelevanceScore: avgScore !== null ? Math.round(avgScore * 1000) / 1000 : null,
    belowDecayThreshold: belowThreshold,
  };
}

// ── Helpers ──

function rowToSearchResult(row: SearchRow): SearchResult {
  return {
    id: row.id,
    source_type: row.source_type,
    source_file: row.source_file,
    chunk_index: row.chunk_index,
    content: row.content,
    metadata: JSON.parse(row.metadata || '{}') as Record<string, unknown>,
    created_at: row.created_at,
    updated_at: row.updated_at,
    rank: row.rank,
    boosted_rank: row.boosted_rank,
    relevance_score: row.relevance_score ?? 0.5,
    access_count: row.access_count ?? 0,
  };
}
