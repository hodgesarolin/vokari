#!/usr/bin/env node

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { initDb, addCorrection, getContext, getStats } from './db.js';
import type { CorrectionType, Permanence } from './db.js';

const args = process.argv.slice(2);
const command = args[0];

function usage(): void {
  console.log(`Usage:
  epistemic import <corrections.md> [--db <path>]   Import corrections from markdown
  epistemic context [--budget <chars>] [--db <path>] Print context block
  epistemic stats [--db <path>]                      Print store statistics

Options:
  --db <path>    Database path (default: ./epistemic.db)
  --budget <n>   Context budget in characters (default: 4000)`);
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

} else {
  usage();
}
