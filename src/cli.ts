#!/usr/bin/env node

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { initDb, addCorrection, getContext, getStats } from './db.js';
import type { CorrectionType, Permanence } from './db.js';
import { initBeliefs, getBeliefStats } from './beliefs.js';
import { initPredictions, listPredictions, getPendingReview } from './predictions.js';
import { initPositions } from './positions.js';
import { initVerifications, verificationStatus } from './verification.js';
import { initKnowledge } from './knowledge.js';
import { calibrationReport } from './calibration.js';
import { startDashboard } from './dashboard.js';

const args = process.argv.slice(2);
const command = args[0];

function usage(): void {
  console.log(`Usage:
  vokari import <corrections.md> [--db <path>]     Import corrections from markdown
  vokari context [--budget <chars>] [--db <path>]  Print context block
  vokari stats [--db <path>]                       Print store statistics
  vokari calibration [--db <path>]                 Print calibration report
  vokari beliefs [--db <path>]                     Print belief statistics
  vokari predictions [--db <path>]                 List pending predictions
  vokari verify [--db <path>]                      Print verification status
  vokari dashboard [--port 3939] [--db <path>]     Start calibration dashboard

Options:
  --db <path>    Database path (default: ./epistemic.db or EPISTEMIC_DB env)
  --budget <n>   Context budget in characters (default: 4000)
  --port <n>     Dashboard port (default: 3939)`);
}

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const dbPath = getArg('--db') ?? process.env.EPISTEMIC_DB ?? './epistemic.db';

interface ParsedCorrection {
  number: number;
  type: CorrectionType;
  permanence: Permanence;
  content: string;
}

/**
 * Parse Brain's corrections.md format:
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
      // Facts about personal info are permanent; public facts are conditional
      currentPermanence = 'never';
      continue;
    }
    if (line.startsWith('## Technical')) {
      currentType = 'technical';
      currentPermanence = 'graduable';
      continue;
    }
    if (line.startsWith('## Graduation') || line.startsWith('## Adherence')) {
      break; // Stop parsing at metadata sections
    }

    // Correction entries: "N. **Title** → Description" or "N. **Title**: Description"
    const match = line.match(/^(\d+)\.\s+\*\*(.+?)\*\*\s*[→:]\s*(.+)/);
    if (match) {
      const num = parseInt(match[1], 10);
      const title = match[2];
      let description = match[3];

      // Some entries span multiple lines — collect continuation
      // (lines that don't start with a number or section header)
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (!next || next.startsWith('#') || /^\d+\.\s+\*\*/.test(next)) break;
        // Skip metadata lines like *(Feb 19, confirmed by Daniel)*
        if (next.startsWith('*(') && next.endsWith(')*')) continue;
        description += ' ' + next;
      }

      // Clean up trailing metadata in parens
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

if (command === 'import') {
  const filePath = args[1];
  if (!filePath || filePath.startsWith('--')) {
    console.error('Error: provide a path to corrections.md');
    process.exit(1);
  }

  const resolved = resolve(filePath);
  const markdown = readFileSync(resolved, 'utf-8');
  const parsed = parseCorrections(markdown);

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
  console.log(`Run 'npx tsx src/server.ts' to serve them via MCP.`);
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

} else if (command === 'dashboard') {
  const port = parseInt(getArg('--port') ?? '3939', 10);
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
