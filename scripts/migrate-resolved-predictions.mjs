#!/usr/bin/env node
/**
 * One-time migration: import resolved predictions from markdown archives
 * into epistemic.db. These 30 predictions predate or were missed by the
 * DB-based tracking system.
 *
 * Source files:
 *   ~/.brain/data/memory/context/archive/predictions-resolved-feb16.md (26)
 *   ~/.brain/data/memory/context/archive/predictions-pre-compression-2026-03-08.md (4)
 *
 * Usage: node scripts/migrate-resolved-predictions.mjs [--db <path>] [--dry-run]
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

const args = process.argv.slice(2);
const dbIdx = args.indexOf('--db');
const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : process.env.EPISTEMIC_DB ?? './epistemic.db';
const dryRun = args.includes('--dry-run');

// ── The 30 missing resolved predictions ──

const predictions = [
  // === Feb 16 archive (predictions 1-26) ===
  {
    topic: 'government-shutdown-feb',
    prediction: 'Government shutdown ends by Feb 5',
    confidence: 0.90,
    domain: 'political',
    outcome: 'correct',
    outcome_notes: 'H.R. 7148 passed 217-214, Feb 3',
    check_date: '2026-02-05',
    created_at: '2026-02-02',
    resolved_at: '2026-02-03',
  },
  {
    topic: 'pr-27-merge',
    prediction: 'PR #27 not merged as-is',
    confidence: 0.85,
    domain: 'behavioral',
    outcome: 'incorrect',
    outcome_notes: 'Daniel merged it; cared about outcome not mechanism',
    check_date: '2026-02-07',
    created_at: '2026-02-02',
    resolved_at: '2026-02-05',
  },
  {
    topic: 'kim-navle',
    prediction: 'Kim passed NAVLE',
    confidence: 0.95,
    domain: 'general',
    outcome: 'correct',
    outcome_notes: 'Certified for four a decade',
    check_date: '2026-02-05',
    created_at: '2026-02-02',
    resolved_at: '2026-02-04',
  },
  {
    topic: 'sonnet-5-release-early',
    prediction: 'Sonnet 5 ships Feb 3-7',
    confidence: 0.35,
    domain: 'technical',
    outcome: 'incorrect',
    outcome_notes: 'Misinformation. Opus 4.6 released instead',
    check_date: '2026-02-07',
    created_at: '2026-02-02',
    resolved_at: '2026-02-07',
  },
  {
    topic: 'sonnet-5-super-bowl',
    prediction: 'Sonnet 5 NOT released Super Bowl weekend',
    confidence: 0.85,
    domain: 'technical',
    outcome: 'correct',
    outcome_notes: 'No announcement on official Anthropic page',
    check_date: '2026-02-10',
    created_at: '2026-02-04',
    resolved_at: '2026-02-10',
  },
  {
    topic: 'research-breaks-cycling',
    prediction: 'External research breaks cycling',
    confidence: 0.80,
    domain: 'behavioral',
    outcome: 'correct',
    outcome_notes: 'GRADUATED to principle',
    check_date: '2026-02-10',
    created_at: '2026-02-03',
    resolved_at: '2026-02-08',
  },
  {
    topic: 'gateway-construction-pause',
    prediction: 'Gateway construction pauses by Feb 7',
    confidence: 0.75,
    domain: 'political',
    outcome: 'correct',
    outcome_notes: 'Halted Feb 6',
    check_date: '2026-02-07',
    created_at: '2026-02-04',
    resolved_at: '2026-02-06',
  },
  {
    topic: 'gateway-dhs-leverage',
    prediction: 'Gateway halt becomes DHS leverage and backfires',
    confidence: 0.75,
    domain: 'political',
    outcome: 'correct',
    outcome_notes: 'TRO issued, protest, major coverage',
    check_date: '2026-02-10',
    created_at: '2026-02-05',
    resolved_at: '2026-02-08',
  },
  {
    topic: 'adversarial-verification-issues',
    prediction: 'Adversarial verification finds 3+ issues',
    confidence: 0.70,
    domain: 'technical',
    outcome: 'correct',
    outcome_notes: 'Found 7 (2 HIGH, 5 MEDIUM)',
    check_date: '2026-02-07',
    created_at: '2026-02-03',
    resolved_at: '2026-02-05',
  },
  {
    topic: 'post-disney-brain-status',
    prediction: 'First post-Disney message is Brain status',
    confidence: 0.65,
    domain: 'behavioral',
    outcome: 'correct',
    outcome_notes: '"Let\'s go over what you were thinking"',
    check_date: '2026-02-10',
    created_at: '2026-02-04',
    resolved_at: '2026-02-10',
  },
  {
    topic: 'disney-engagement-rate',
    prediction: 'Daniel engages at high rate during Disney',
    confidence: 0.65,
    domain: 'behavioral',
    outcome: 'correct',
    outcome_notes: '10+ messages on 5 of 6 days',
    check_date: '2026-02-10',
    created_at: '2026-02-04',
    resolved_at: '2026-02-10',
  },
  {
    topic: 'rootscribe-product',
    prediction: 'RootScribe is a product concept',
    confidence: 0.60,
    domain: 'behavioral',
    outcome: 'correct',
    outcome_notes: 'Daniel built full CLI + web UI',
    check_date: '2026-02-14',
    created_at: '2026-02-04',
    resolved_at: '2026-02-12',
  },
  {
    topic: 'gateway-injunction',
    prediction: 'Gateway hearing results in preliminary injunction',
    confidence: 0.65,
    domain: 'political',
    outcome: 'correct',
    outcome_notes: 'Vargas granted injunction',
    check_date: '2026-02-14',
    created_at: '2026-02-10',
    resolved_at: '2026-02-12',
  },
  {
    topic: 'post-disney-personal',
    prediction: 'First post-Disney message is personal',
    confidence: 0.70,
    domain: 'behavioral',
    outcome: 'incorrect',
    outcome_notes: 'Was task-oriented (Brain status)',
    check_date: '2026-02-10',
    created_at: '2026-02-10',
    resolved_at: '2026-02-10',
  },
  {
    topic: '2nd-circuit-gateway',
    prediction: '2nd Circuit denies Gateway stay',
    confidence: 0.50,
    domain: 'political',
    outcome: 'correct',
    outcome_notes: '2nd Circuit declined to act',
    check_date: '2026-02-14',
    created_at: '2026-02-12',
    resolved_at: '2026-02-13',
  },
  {
    topic: 'senate-hearing-rhetoric',
    prediction: 'Senate hearing: rhetoric no policy',
    confidence: 0.80,
    domain: 'political',
    outcome: 'correct',
    outcome_notes: 'No binding policy changes',
    check_date: '2026-02-13',
    created_at: '2026-02-12',
    resolved_at: '2026-02-12',
  },
  {
    topic: 'nj-assembly-a4071-committee',
    prediction: 'NJ Assembly advances A4071 in committee',
    confidence: 0.70,
    domain: 'political',
    outcome: 'correct',
    outcome_notes: 'Passed committee Feb 12',
    check_date: '2026-02-14',
    created_at: '2026-02-12',
    resolved_at: '2026-02-12',
  },
  {
    topic: 'dhs-shutdown-feb14',
    prediction: 'DHS partial shutdown starts Feb 14',
    confidence: 0.95,
    domain: 'political',
    outcome: 'correct',
    outcome_notes: 'Shutdown began 12:01 AM Saturday',
    check_date: '2026-02-14',
    created_at: '2026-02-13',
    resolved_at: '2026-02-14',
  },
  {
    topic: 'brain-102-priority',
    prediction: 'Daniel prioritizes BRAIN-102',
    confidence: 0.70,
    domain: 'behavioral',
    outcome: 'voided',
    outcome_notes: 'Brain fixed autonomously — moot',
    check_date: '2026-02-16',
    created_at: '2026-02-13',
    resolved_at: '2026-02-14',
  },
  {
    topic: 'detection-aggressive-trust',
    prediction: 'Detection-aggressive systems build more trust',
    confidence: 0.70,
    domain: 'technical',
    outcome: 'correct',
    outcome_notes: 'Graduated to Position #27',
    check_date: '2026-02-16',
    created_at: '2026-02-13',
    resolved_at: '2026-02-15',
  },
  {
    topic: 'sonnet-5-h1',
    prediction: 'Sonnet 5 releases H1 2026',
    confidence: 0.80,
    domain: 'technical',
    outcome: 'correct',
    outcome_notes: 'Launched Feb 3',
    check_date: '2026-06-30',
    created_at: '2026-02-14',
    resolved_at: '2026-02-14',
  },
  {
    topic: 'health-recurring-jtbd',
    prediction: 'Health becomes recurring JTBD',
    confidence: 0.65,
    domain: 'behavioral',
    outcome: 'correct',
    outcome_notes: '4+ health topics in 2 days',
    check_date: '2026-02-21',
    created_at: '2026-02-14',
    resolved_at: '2026-02-16',
  },
  {
    topic: 'health-wellness-jtbd',
    prediction: 'Health/wellness recurring JTBD (P-303-1)',
    confidence: 0.65,
    domain: 'behavioral',
    outcome: 'correct',
    outcome_notes: 'Exceeded threshold in 2 days',
    check_date: '2026-02-21',
    created_at: '2026-02-14',
    resolved_at: '2026-02-16',
  },
  {
    topic: 'valentines-gift',
    prediction: "Valentine's gift approach lands",
    confidence: 0.55,
    domain: 'behavioral',
    outcome: 'voided',
    outcome_notes: 'No feedback from Daniel — moot',
    check_date: '2026-02-15',
    created_at: '2026-02-14',
    resolved_at: '2026-02-15',
  },
  {
    topic: 'first-side-income-action',
    prediction: "Daniel's first side income action = agreement check",
    confidence: 0.15,
    domain: 'behavioral',
    outcome: 'incorrect',
    outcome_notes: 'First actions: resume + arxiv share. Wrong but expected at 15%',
    check_date: '2026-02-21',
    created_at: '2026-02-14',
    resolved_at: '2026-02-16',
  },
  {
    topic: 'discussion-links',
    prediction: 'Daniel shares 2+ discussion-only links by Feb 26',
    confidence: 0.40,
    domain: 'behavioral',
    outcome: 'correct',
    outcome_notes: 'Kurzweil (Feb 13) + arxiv (Feb 16)',
    check_date: '2026-02-26',
    created_at: '2026-02-14',
    resolved_at: '2026-02-16',
  },

  // === Post-Feb-16 resolutions missing from DB (4) ===
  {
    topic: 'sotu-immigration',
    prediction: 'SOTU: Immigration is dominant topic (>30% of speech time)',
    confidence: 0.55,
    domain: 'political',
    outcome: 'incorrect',
    outcome_notes: 'Economy dominated. Immigration was one of ~15 topics. CBS assessed <30%. Brier: 0.3025',
    check_date: '2026-02-24',
    created_at: '2026-02-20',
    resolved_at: '2026-02-24',
  },
  {
    topic: 'iran-round-3',
    prediction: 'Iran Round 3 results in progress + continuation (not framework deal)',
    confidence: 0.55,
    domain: 'political',
    outcome: 'correct',
    outcome_notes: 'Oman FM: "significant progress." Technical talks scheduled for Vienna. Brier: 0.2025',
    check_date: '2026-02-26',
    created_at: '2026-02-24',
    resolved_at: '2026-02-26',
  },
  {
    topic: 'iran-strike',
    prediction: 'US military strike on Iran before November 2026',
    confidence: 0.15,
    domain: 'political',
    outcome: 'incorrect',
    outcome_notes: 'EVENT OCCURRED Feb 28. US-Israel joint strikes launched. Brain 15% YES → outcome YES. Brier: 0.7225 — worst single prediction. Insiders said 90%, should have believed them.',
    check_date: '2026-11-01',
    created_at: '2026-02-20',
    resolved_at: '2026-02-28',
  },
  {
    topic: 'deepseek-v4-feb',
    prediction: 'DeepSeek V4 drops by Feb 21',
    confidence: 0.15,
    domain: 'technical',
    outcome: 'correct',
    outcome_notes: 'V4 was NOT released by Feb 21. 15% "unlikely" correctly calibrated.',
    check_date: '2026-02-21',
    created_at: '2026-02-18',
    resolved_at: '2026-02-21',
  },
];

// ── Run migration ──

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Verify none already exist (by topic)
const existing = db.prepare('SELECT topic FROM predictions').all().map(r => r.topic);
const dupes = predictions.filter(p => existing.includes(p.topic));
if (dupes.length > 0) {
  console.log(`WARNING: ${dupes.length} predictions already exist by topic:`);
  for (const d of dupes) console.log(`  - ${d.topic}`);
  console.log('Skipping these.\n');
}

const toInsert = predictions.filter(p => !existing.includes(p.topic));

if (dryRun) {
  console.log(`DRY RUN — would insert ${toInsert.length} resolved predictions:\n`);
  for (const p of toInsert) {
    console.log(`  [${p.outcome}] ${(p.confidence * 100).toFixed(0)}% — ${p.prediction}`);
  }
  console.log(`\nSkipped ${dupes.length} duplicates.`);
  process.exit(0);
}

const insert = db.prepare(`
  INSERT INTO predictions (id, topic, prediction, confidence, reasoning, resolution_criteria, check_date, domain, outcome, outcome_notes, resolved_at, created_at, revision_history)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')
`);

const txn = db.transaction(() => {
  let count = 0;
  for (const p of toInsert) {
    insert.run(
      randomUUID(),
      p.topic,
      p.prediction,
      p.confidence,
      null,                    // reasoning
      null,                    // resolution_criteria
      p.check_date,
      p.domain ?? 'general',
      p.outcome,
      p.outcome_notes ?? null,
      p.resolved_at,
      p.created_at,
    );
    count++;
    console.log(`  [${p.outcome}] ${(p.confidence * 100).toFixed(0)}% — ${p.prediction}`);
  }
  return count;
});

const inserted = txn();
console.log(`\nInserted ${inserted} resolved predictions into ${dbPath}`);
console.log(`Skipped ${dupes.length} duplicates.`);

// Print new calibration stats
const resolved = db.prepare("SELECT confidence, outcome FROM predictions WHERE outcome IS NOT NULL AND outcome != 'voided'").all();
const total = resolved.length;
const correct = resolved.filter(r => r.outcome === 'correct').length;
const partial = resolved.filter(r => r.outcome === 'partial').length;
const accuracy = total > 0 ? (correct + partial * 0.5) / total : 0;
const brier = total > 0
  ? resolved.reduce((sum, r) => {
      const actual = r.outcome === 'correct' ? 1 : r.outcome === 'partial' ? 0.5 : 0;
      return sum + (r.confidence - actual) ** 2;
    }, 0) / total
  : 0;

console.log(`\nUpdated calibration:`);
console.log(`  Resolved: ${total} (excl. voided)`);
console.log(`  Correct: ${correct}, Partial: ${partial}`);
console.log(`  Accuracy: ${(accuracy * 100).toFixed(1)}%`);
console.log(`  Brier: ${brier.toFixed(4)}`);

db.close();
