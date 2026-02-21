#!/usr/bin/env npx tsx
/**
 * Import script: migrates data from Brain's two databases into the unified knowledge store.
 *
 * Sources:
 *   1. epistemic.db — beliefs, corrections, positions, predictions (via built-in migration fns)
 *   2. rag.db — chunks (source_type mapped to knowledge type)
 *
 * Usage:
 *   npx tsx scripts/import-to-knowledge.ts [--target brain.db] [--epistemic path] [--rag path] [--dry-run]
 *
 * The script is idempotent: re-running skips already-imported rows (checked by key/type).
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { resolve, join, basename, extname } from 'node:path';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import {
  initKnowledge,
  importAllToKnowledge,
  importChunksToKnowledge,
  addKnowledge,
  getKnowledgeByKey,
  getKnowledgeStats,
  listKnowledge,
} from '../src/knowledge.js';
import type { KnowledgeType } from '../src/knowledge.js';
import { initDb } from '../src/db.js';

// ── CLI Args ──

function parseArgs(): {
  targetPath: string;
  epistemicPath: string;
  ragPath: string;
  dryRun: boolean;
} {
  const args = process.argv.slice(2);
  let targetPath = './brain.db';
  let epistemicPath = './epistemic.db';
  let ragPath = '';
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--target':
        targetPath = args[++i];
        break;
      case '--epistemic':
        epistemicPath = args[++i];
        break;
      case '--rag':
        ragPath = args[++i];
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--help':
        console.log(`
Usage: npx tsx scripts/import-to-knowledge.ts [options]

Options:
  --target <path>     Target database path (default: ./brain.db)
  --epistemic <path>  Epistemic database path (default: ./epistemic.db)
  --rag <path>        RAG database path (optional, chunks import)
  --dry-run           Show what would be imported without writing
  --help              Show this help
`);
        process.exit(0);
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }

  return {
    targetPath: resolve(targetPath),
    epistemicPath: resolve(epistemicPath),
    ragPath: ragPath ? resolve(ragPath) : '',
    dryRun,
  };
}

// ── Source type mapping: rag.db source_type → knowledge type ──

const RAG_TYPE_MAP: Record<string, KnowledgeType> = {
  context: 'context',
  research: 'research',
  archive: 'archive',
  daily: 'daily',
  transcript: 'transcript',
  session: 'session',
  ticket: 'ticket',
  digest: 'digest',
  summary: 'context',
  second_brain: 'research',
};

// ── Import chunks from rag.db ──

interface RagChunk {
  id: number;
  source_type: string;
  source_file: string;
  chunk_index: number;
  content: string;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

function importRagChunks(
  targetDb: Database.Database,
  ragPath: string,
  dryRun: boolean,
): number {
  const ragDb = new Database(ragPath, { readonly: true });

  try {
    const chunks = ragDb.prepare('SELECT * FROM chunks ORDER BY source_type, source_file, chunk_index').all() as RagChunk[];

    console.log(`  Found ${chunks.length} chunks in rag.db`);

    if (dryRun) {
      // Count by type
      const typeCounts: Record<string, number> = {};
      for (const chunk of chunks) {
        const type = RAG_TYPE_MAP[chunk.source_type] ?? chunk.source_type;
        typeCounts[type] = (typeCounts[type] ?? 0) + 1;
      }
      console.log('  Chunk type distribution:');
      for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${type}: ${count}`);
      }
      return chunks.length;
    }

    // Batch insert for performance
    let imported = 0;
    let skipped = 0;

    const insertStmt = targetDb.prepare(`
      INSERT OR IGNORE INTO knowledge (id, type, key, content, metadata, created_at, updated_at, mutable)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `);

    const insertMany = targetDb.transaction((chunkBatch: RagChunk[]) => {
      for (const chunk of chunkBatch) {
        const knowledgeType = RAG_TYPE_MAP[chunk.source_type] ?? chunk.source_type;

        // Key: source_file + chunk_index for dedup
        const key = `${chunk.source_file}:${chunk.chunk_index}`;

        // Check if already exists
        const existing = getKnowledgeByKey(targetDb, knowledgeType as KnowledgeType, key);
        if (existing) {
          skipped++;
          continue;
        }

        const metadata: Record<string, unknown> = {};
        if (chunk.metadata) {
          try {
            Object.assign(metadata, JSON.parse(chunk.metadata));
          } catch {
            // Non-JSON metadata, store as-is
            metadata.raw = chunk.metadata;
          }
        }
        metadata.source_file = chunk.source_file;
        metadata.chunk_index = chunk.chunk_index;
        metadata.source_type = chunk.source_type;
        metadata.imported_from = 'rag.db';

        const id = randomUUID();

        insertStmt.run(
          id,
          knowledgeType,
          key,
          chunk.content,
          JSON.stringify(metadata),
          chunk.created_at,
          chunk.updated_at,
        );
        imported++;
      }
    });

    // Process in batches of 500
    const BATCH_SIZE = 500;
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      insertMany(batch);
    }

    console.log(`  Imported: ${imported}, Skipped (already exist): ${skipped}`);
    return imported;
  } finally {
    ragDb.close();
  }
}

// ── Import epistemic tables (beliefs, corrections, positions, predictions) ──

function importEpistemic(
  targetDb: Database.Database,
  epistemicPath: string,
  dryRun: boolean,
): { beliefs: number; corrections: number; positions: number; predictions: number } {
  // The epistemic tables live in the SAME db that we initialize with initDb.
  // The importAllToKnowledge function reads from the legacy tables and writes to knowledge.
  // Since we already called initDb on the target, legacy tables exist there if it's the epistemic db.

  // For the case where epistemic.db is SEPARATE from target, we need to
  // attach it and copy the legacy tables first.

  const epistemicDb = new Database(epistemicPath, { readonly: true });

  try {
    // Count what we'd import
    const counts = {
      beliefs: (epistemicDb.prepare('SELECT COUNT(*) as c FROM beliefs').get() as { c: number })?.c ?? 0,
      corrections: (epistemicDb.prepare('SELECT COUNT(*) as c FROM corrections').get() as { c: number })?.c ?? 0,
      positions: (epistemicDb.prepare('SELECT COUNT(*) as c FROM positions').get() as { c: number })?.c ?? 0,
      predictions: (epistemicDb.prepare('SELECT COUNT(*) as c FROM predictions').get() as { c: number })?.c ?? 0,
    };

    console.log(`  Found: ${counts.beliefs} beliefs, ${counts.corrections} corrections, ${counts.positions} positions, ${counts.predictions} predictions`);

    if (dryRun) {
      return counts;
    }

    // Attach epistemic.db to target for cross-db queries
    targetDb.exec(`ATTACH DATABASE '${epistemicPath}' AS epistemic_source`);

    // Copy legacy tables from epistemic to target's main schema
    // so importAllToKnowledge can find them

    // Check if target already has these tables (from initDb)
    const tableExists = (name: string) => {
      const row = targetDb.prepare(
        "SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name=?"
      ).get(name) as { c: number };
      return row.c > 0;
    };

    // If beliefs table exists in target but is empty, copy from source
    const tables = ['beliefs', 'corrections', 'positions', 'predictions'];
    for (const table of tables) {
      if (tableExists(table)) {
        const targetCount = (targetDb.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
        if (targetCount === 0) {
          // Copy from source
          const rows = epistemicDb.prepare(`SELECT * FROM ${table}`).all();
          if (rows.length > 0) {
            const columns = Object.keys(rows[0] as Record<string, unknown>);
            const placeholders = columns.map(() => '?').join(',');
            const insert = targetDb.prepare(
              `INSERT OR IGNORE INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`
            );
            const insertAll = targetDb.transaction((rowBatch: Record<string, unknown>[]) => {
              for (const row of rowBatch) {
                insert.run(...columns.map(c => row[c]));
              }
            });
            insertAll(rows as Record<string, unknown>[]);
            console.log(`  Copied ${rows.length} rows to ${table} table`);
          }
        } else {
          console.log(`  ${table} table already has ${targetCount} rows, skipping copy`);
        }
      }
    }

    targetDb.exec('DETACH DATABASE epistemic_source');

    // Now use the built-in migration functions
    const result = importAllToKnowledge(targetDb);
    console.log(`  Migrated to knowledge: ${result.beliefs} beliefs, ${result.corrections} corrections, ${result.positions} positions, ${result.predictions} predictions`);

    return result;
  } finally {
    epistemicDb.close();
  }
}

// ── Import markdown context files ──

function importContextFiles(
  targetDb: Database.Database,
  contextDir: string,
  dryRun: boolean,
): number {
  let imported = 0;

  try {
    const files = readdirSync(contextDir).filter((f: string) => extname(f) === '.md');
    console.log(`  Found ${files.length} markdown files in ${contextDir}`);

    if (dryRun) {
      for (const file of files) {
        console.log(`    ${file}`);
      }
      return files.length;
    }

    for (const file of files) {
      const key = basename(file, '.md');
      const filePath = join(contextDir, file);
      const content = readFileSync(filePath, 'utf-8');
      const stat = statSync(filePath);

      // Determine type based on file name patterns
      let type: KnowledgeType = 'context';
      const mutable = false;

      // Handoff files are mutable
      const handoffKeys = [
        'interactive-context', 'last-session-handoff', 'nightly-state', 'daily-todos',
        'deep-improvement-progress', 'deep-improvement-report',
      ];

      if (handoffKeys.includes(key)) {
        type = 'handoff';
      }

      // Check if already exists
      const existing = getKnowledgeByKey(targetDb, type, key);
      if (existing) {
        console.log(`    Skipping ${key} (already exists)`);
        continue;
      }

      addKnowledge(targetDb, {
        type,
        key,
        content,
        metadata: {
          source_file: filePath,
          imported_from: 'context_files',
          mtime: stat.mtime.toISOString(),
        },
        mutable: handoffKeys.includes(key),
      });

      imported++;
      console.log(`    Imported ${key} (${type}, ${content.length} chars)`);
    }
  } catch (err) {
    console.log(`  Context dir not found or not readable: ${contextDir}`);
  }

  return imported;
}

// ── Main ──

async function main() {
  const config = parseArgs();

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Vokari Unified Knowledge Store — Import Tool   ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log();

  if (config.dryRun) {
    console.log('🔍 DRY RUN — no data will be written\n');
  }

  console.log(`Target:    ${config.targetPath}`);
  console.log(`Epistemic: ${config.epistemicPath}`);
  console.log(`RAG:       ${config.ragPath || '(not specified)'}`);
  console.log();

  // Initialize target database
  const targetDb = initDb(config.targetPath);
  initKnowledge(targetDb);

  // Pre-import stats
  const preStats = getKnowledgeStats(targetDb);
  console.log(`Pre-import knowledge rows: ${preStats.total}\n`);

  // ── 1. Import epistemic tables ──
  console.log('─── Epistemic Import ───');
  const epistemicResult = importEpistemic(targetDb, config.epistemicPath, config.dryRun);
  console.log();

  // ── 2. Import RAG chunks ──
  let ragImported = 0;
  if (config.ragPath) {
    console.log('─── RAG Chunks Import ───');
    ragImported = importRagChunks(targetDb, config.ragPath, config.dryRun);
    console.log();
  }

  // ── 3. Import context files (if context dir exists next to epistemic) ──
  const contextDir = resolve(config.epistemicPath, '../../data/memory/context');
  if (existsSync(contextDir)) {
    console.log('─── Context Files Import ───');
    const contextImported = importContextFiles(targetDb, contextDir, config.dryRun);
    console.log(`  Total context files: ${contextImported}\n`);
  }

  // ── Summary ──
  if (!config.dryRun) {
    const postStats = getKnowledgeStats(targetDb);
    console.log('═══ Import Summary ═══');
    console.log(`Knowledge rows: ${preStats.total} → ${postStats.total} (+${postStats.total - preStats.total})`);
    console.log(`By type:`);
    for (const [type, count] of Object.entries(postStats.byType).sort((a, b) => (b[1] as number) - (a[1] as number))) {
      console.log(`  ${type}: ${count}`);
    }

    // Validate
    console.log('\n═══ Validation ═══');
    let valid = true;

    // Check FTS5 works
    try {
      const ftsResults = targetDb.prepare(
        "SELECT COUNT(*) as c FROM knowledge_fts WHERE knowledge_fts MATCH 'test'"
      ).get() as { c: number };
      console.log(`✓ FTS5 index operational (${ftsResults.c} results for 'test')`);
    } catch (err) {
      console.log(`✗ FTS5 index error: ${err}`);
      valid = false;
    }

    // Check row count
    const actualCount = (targetDb.prepare('SELECT COUNT(*) as c FROM knowledge').get() as { c: number }).c;
    if (actualCount === postStats.total) {
      console.log(`✓ Row count consistent: ${actualCount}`);
    } else {
      console.log(`✗ Row count mismatch: knowledge=${actualCount}, stats=${postStats.total}`);
      valid = false;
    }

    console.log(valid ? '\n✅ Import complete and validated.' : '\n⚠️ Import complete with validation issues.');
  } else {
    console.log('═══ Dry Run Complete ═══');
    console.log('Run without --dry-run to execute import.');
  }

  targetDb.close();
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
