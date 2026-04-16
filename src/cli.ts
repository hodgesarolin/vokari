#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { initDb, addCorrection, getContext, getStats } from './db.js';
import type { CorrectionType, Permanence } from './db.js';
import { initBeliefs, getBeliefStats } from './beliefs.js';
import { initPredictions, listPredictions, getPendingReview } from './predictions.js';
import { initPositions } from './positions.js';
import { initVerifications, verificationStatus } from './verification.js';
import { initKnowledge } from './knowledge.js';
import { calibrationReport } from './calibration.js';
import { startDashboard, getDashboardData } from './dashboard.js';
import { compileDigest } from './digest.js';

const args = process.argv.slice(2);
const command = args[0];

function usage(): void {
  console.log(`Usage:
  vokari init [--db <path>]                        Initialize a new database
  vokari import <corrections.md> [--db <path>]     Import corrections from markdown
  vokari export [--db <path>] [--out <path>]       Export all data as JSON
  vokari context [--budget <chars>] [--db <path>]  Print context block
  vokari stats [--db <path>]                       Print store statistics
  vokari calibration [--db <path>]                 Print calibration report
  vokari beliefs [--db <path>]                     Print belief statistics
  vokari predictions [--db <path>]                 List pending predictions
  vokari verify [--db <path>]                      Print verification status
  vokari serve [--dashboard] [--port 3838] [--db <path>]  Start MCP server (+ optional dashboard)
  vokari dashboard [--port 3838] [--db <path>]     Start calibration dashboard

Options:
  --db <path>    Database path (default: ./epistemic.db or EPISTEMIC_DB env)
  --budget <n>   Context budget in characters (default: 4000)
  --port <n>     Dashboard port (default: 3838)
  --out <path>   Export output path (default: stdout)`);
}

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

const dbPath = getArg('--db') ?? process.env.EPISTEMIC_DB ?? './epistemic.db';

interface ParsedCorrection {
  number: number;
  type: CorrectionType;
  permanence: Permanence;
  content: string;
}

/**
 * Parse corrections.md format:
 *
 *   ## Policy (NEVER graduate)
 *   1. **Title** → Description
 *
 *   ## Pattern
 *   3. **Title** → Description
 *
 *   ## Fact
 *   16. **Kim's income**: ~$120K/yr, ~$105/hr (NOT $96 or $115)
 *
 *   ## Technical
 *   22. **No MCP tools in cron** → Description
 */
function parseCorrections(markdown: string): ParsedCorrection[] {
  const corrections: ParsedCorrection[] = [];
  let currentType: CorrectionType = 'pattern';
  let currentPermanence: Permanence = 'conditional';

  const lines = markdown.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Section headers
    if (line.startsWith('## Policy')) {
      currentType = 'policy';
      currentPermanence = 'never';
      continue;
    }
    if (line.startsWith('## Pattern')) {
      currentType = 'pattern';
      currentPermanence = 'graduable';
      continue;
    }
    if (line.startsWith('## Fact')) {
      currentType = 'fact';
      currentPermanence = 'never';
      continue;
    }
    if (line.startsWith('## Technical')) {
      currentType = 'technical';
      currentPermanence = 'graduable';
      continue;
    }
    if (line.startsWith('## Graduation') || line.startsWith('## Adherence')) {
      break;
    }

    // Correction entries: "N. **Title** → Description" or "N. **Title**: Description"
    const match = line.match(/^(\d+)\.\s+\*\*(.+?)\*\*\s*[→:]\s*(.+)/);
    if (match) {
      const num = parseInt(match[1], 10);
      const title = match[2];
      let description = match[3];

      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (!next || next.startsWith('#') || /^\d+\.\s+\*\*/.test(next)) break;
        if (next.startsWith('*(') && next.endsWith(')*')) continue;
        description += ' ' + next;
      }

      description = description.replace(/\s*\*\(.+?\)\*\s*$/, '').trim();

      corrections.push({
        number: num,
        type: currentType,
        permanence: currentPermanence,
        content: `${title}: ${description}`,
      });
    }
  }

  return corrections;
}

if (command === 'init') {
  const db = initDb(dbPath);
  initKnowledge(db);
  console.log(`Initialized Vokari database at ${dbPath}`);
  console.log(`Tables: corrections, beliefs, predictions, positions, verifications, knowledge`);
  db.close();

} else if (command === 'import') {
  const filePath = args[1];
  if (!filePath || filePath.startsWith('--')) {
    console.error('Error: provide a path to a corrections.md or JSON backup file');
    process.exit(1);
  }

  const resolved = resolve(filePath);
  const content = readFileSync(resolved, 'utf-8');

  // Detect file format: JSON backup or markdown corrections
  if (filePath.endsWith('.json') || content.trimStart().startsWith('{')) {
    // JSON backup import
    const data = JSON.parse(content);
    const db = initDb(dbPath);
    initKnowledge(db);

    const counts = { corrections: 0, beliefs: 0, predictions: 0, positions: 0, knowledge: 0 };

    const txn = db.transaction(() => {
      if (data.corrections) {
        for (const row of data.corrections) {
          db.prepare(`INSERT OR IGNORE INTO corrections (id, type, content, root_cause, example_bad, example_good, permanence, created_at, last_violated, violation_count, streak_days, graduation_eligible, graduated_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            row.id, row.type, row.content, row.root_cause, row.example_bad, row.example_good,
            row.permanence, row.created_at, row.last_violated, row.violation_count, row.streak_days,
            row.graduation_eligible, row.graduated_at, row.source
          );
          counts.corrections++;
        }
      }
      if (data.beliefs) {
        for (const row of data.beliefs) {
          db.prepare(`INSERT OR IGNORE INTO beliefs (id, statement, category, confidence, sensitivity, source, evidence, tags, status, first_recorded, last_confirmed, contradictions, revision_history) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            row.id, row.statement, row.category, row.confidence, row.sensitivity ?? 'approximate',
            row.source, row.evidence, row.tags, row.status, row.first_recorded, row.last_confirmed,
            row.contradictions, row.revision_history
          );
          counts.beliefs++;
        }
      }
      if (data.predictions) {
        for (const row of data.predictions) {
          db.prepare(`INSERT OR IGNORE INTO predictions (id, topic, prediction, confidence, reasoning, resolution_criteria, check_date, domain, outcome, outcome_notes, resolved_at, created_at, supersedes, revision_history) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            row.id, row.topic, row.prediction, row.confidence, row.reasoning, row.resolution_criteria,
            row.check_date, row.domain, row.outcome, row.outcome_notes, row.resolved_at, row.created_at,
            row.supersedes, row.revision_history ?? '[]'
          );
          counts.predictions++;
        }
      }
      if (data.positions) {
        for (const row of data.positions) {
          db.prepare(`INSERT OR IGNORE INTO positions (id, topic, position, reasoning, evidence, confidence, status, created_at, last_challenged, challenge_count, revision_history, supersedes, counterevidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            row.id, row.topic, row.position, row.reasoning, row.evidence, row.confidence, row.status,
            row.created_at, row.last_challenged, row.challenge_count, row.revision_history,
            row.supersedes, row.counterevidence
          );
          counts.positions++;
        }
      }
      if (data.knowledge) {
        for (const row of data.knowledge) {
          db.prepare(`INSERT OR IGNORE INTO knowledge (id, type, key, content, metadata, created_at, updated_at, mutable) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
            row.id, row.type, row.key, row.content, row.metadata, row.created_at, row.updated_at, row.mutable
          );
          counts.knowledge++;
        }
      }
    });
    txn();

    console.log(`Imported from JSON backup:`);
    console.log(`  Corrections: ${counts.corrections}`);
    console.log(`  Beliefs: ${counts.beliefs}`);
    console.log(`  Predictions: ${counts.predictions}`);
    console.log(`  Positions: ${counts.positions}`);
    console.log(`  Knowledge: ${counts.knowledge}`);
    db.close();
  } else {
    // Markdown corrections import
    const parsed = parseCorrections(content);

    if (parsed.length === 0) {
      console.error('No corrections found in file.');
      process.exit(1);
    }

    const db = initDb(dbPath);

    let imported = 0;
    for (const c of parsed) {
      addCorrection(db, {
        type: c.type,
        content: c.content,
        permanence: c.permanence,
        source: `import:corrections.md#${c.number}`,
      });
      imported++;
      console.log(`  [${c.type}] #${c.number}: ${c.content.slice(0, 80)}${c.content.length > 80 ? '...' : ''}`);
    }

    console.log(`\nImported ${imported} corrections into ${dbPath}`);
    db.close();
  }

} else if (command === 'export') {
  const db = initDb(dbPath);
  initKnowledge(db);

  const data = {
    exported_at: new Date().toISOString(),
    corrections: db.prepare('SELECT * FROM corrections').all(),
    beliefs: db.prepare('SELECT * FROM beliefs').all(),
    predictions: db.prepare('SELECT * FROM predictions').all(),
    positions: db.prepare('SELECT * FROM positions').all(),
    knowledge: db.prepare('SELECT * FROM knowledge').all(),
  };

  const json = JSON.stringify(data, null, 2);
  const outPath = getArg('--out');
  if (outPath) {
    writeFileSync(outPath, json, 'utf-8');
    console.log(`Exported to ${outPath}`);
  } else {
    console.log(json);
  }
  db.close();

} else if (command === 'context') {
  const budget = parseInt(getArg('--budget') ?? '4000', 10);
  const db = initDb(dbPath);
  console.log(getContext(db, budget));
  db.close();

} else if (command === 'stats') {
  const db = initDb(dbPath);
  const s = getStats(db);
  console.log(`Total: ${s.total} (${s.active} active, ${s.graduated} graduated)`);
  console.log(`By type: policy=${s.by_type.policy}, fact=${s.by_type.fact}, pattern=${s.by_type.pattern}, technical=${s.by_type.technical}`);
  console.log(`By permanence: never=${s.by_permanence.never}, conditional=${s.by_permanence.conditional}, graduable=${s.by_permanence.graduable}`);
  console.log(`Total violations: ${s.total_violations}`);
  db.close();

} else if (command === 'calibration') {
  const db = initDb(dbPath);
  initPredictions(db);
  console.log(calibrationReport(db));
  db.close();

} else if (command === 'beliefs') {
  const db = initDb(dbPath);
  initBeliefs(db);
  const s = getBeliefStats(db);
  console.log(`Total: ${s.total}`);
  console.log(`Active: ${s.byStatus.active}, Challenged: ${s.byStatus.challenged}, Revised: ${s.byStatus.revised}, Retired: ${s.byStatus.retired}`);
  console.log(`By category: user=${s.byCategory.user}, system=${s.byCategory.system}, world=${s.byCategory.world}, self=${s.byCategory.self}`);
  console.log(`Contradictions: ${s.totalContradictions}`);
  if (s.challenged.length > 0) {
    console.log('\nChallenged beliefs:');
    for (const b of s.challenged) {
      console.log(`  [${b.id.slice(0, 8)}] ${b.statement} (${b.contradictionCount} contradictions)`);
    }
  }
  db.close();

} else if (command === 'predictions') {
  const db = initDb(dbPath);
  initPredictions(db);
  const pending = getPendingReview(db);
  if (pending.length === 0) {
    console.log('No predictions due for review.');
  } else {
    console.log(`${pending.length} prediction(s) due for review:\n`);
    for (const p of pending) {
      console.log(`  [${p.id.slice(0, 8)}] ${p.prediction}`);
      console.log(`    Confidence: ${Math.round(p.confidence * 100)}% | Domain: ${p.domain} | Check: ${p.check_date}`);
    }
  }
  const all = listPredictions(db, { resolved: false });
  console.log(`\n${all.length} total pending predictions.`);
  db.close();

} else if (command === 'verify') {
  const db = initDb(dbPath);
  initBeliefs(db);
  initVerifications(db);
  const s = verificationStatus(db);
  console.log(`Total verifications: ${s.total}`);
  console.log(`Status: pending=${s.by_status.pending}, in_progress=${s.by_status.in_progress}, completed=${s.by_status.completed}, skipped=${s.by_status.skipped}`);
  console.log(`Outcomes: confirmed=${s.by_outcome.confirmed}, revised=${s.by_outcome.revised}, contradicted=${s.by_outcome.contradicted}, inconclusive=${s.by_outcome.inconclusive}`);
  console.log(`Coverage: ${s.beliefs_verified} verified, ${s.beliefs_never_verified} never verified`);
  if (s.average_time_to_verify_hours !== null) {
    console.log(`Avg verify time: ${s.average_time_to_verify_hours.toFixed(1)}h`);
  }
  db.close();

} else if (command === 'serve') {
  const db = initDb(dbPath);
  initKnowledge(db);

  if (hasFlag('--dashboard')) {
    const port = parseInt(getArg('--port') ?? '3838', 10);
    startDashboard(db, port);
  }

  // Start MCP server on stdio
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  // The server module handles tool registration — for serve, we just start stdio transport
  // Note: In practice, the main server.ts module is the MCP entry point.
  // This command is a convenience wrapper.
  console.error('MCP server starting on stdio...');
  const transport = new StdioServerTransport();

} else if (command === 'dashboard') {
  const port = parseInt(getArg('--port') ?? '3838', 10);
  const db = initDb(dbPath);
  initBeliefs(db);
  initPredictions(db);
  initPositions(db);
  initVerifications(db);
  initKnowledge(db);
  startDashboard(db, port);

} else {
  usage();
}
