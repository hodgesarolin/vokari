/**
 * F9 — Adversarial Self-Verification for Vokari.
 *
 * Host-agnostic verification system. The host (Brain, Claude Desktop,
 * ChatGPT, etc.) calls verificationTick() whenever it has attention budget.
 * Vokari tracks what's been checked, when, and what happened. The LLM does
 * the actual adversarial reasoning.
 *
 * Design principles:
 * - Tick model: Vokari doesn't own the loop, the host calls tick()
 * - Shared store = shared coordination: no redundant work across hosts
 * - Priority: never_verified > challenged > stale > high_confidence
 * - Cooldown: recently verified beliefs are skipped automatically
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { Belief } from './beliefs.js';
import { resolveId } from './db.js';

// ── Types ──

export type VerificationStatus = 'pending' | 'in_progress' | 'completed' | 'skipped';
export type VerificationOutcome = 'confirmed' | 'revised' | 'contradicted' | 'inconclusive';
export type VerificationStrategy =
  | 'never_verified'   // belief.last_confirmed is NULL
  | 'staleness'        // belief hasn't been checked in a while
  | 'contradiction'    // belief already has contradictions
  | 'high_confidence'  // high confidence = high cost if wrong
  | 'challenged'       // belief is in challenged status
  | 'manual';          // explicitly queued by host

export interface Verification {
  id: string;
  belief_id: string;
  status: VerificationStatus;
  strategy: VerificationStrategy;
  outcome: VerificationOutcome | null;
  evidence: string[];
  notes: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface VerificationRow {
  id: string;
  belief_id: string;
  status: VerificationStatus;
  strategy: VerificationStrategy;
  outcome: VerificationOutcome | null;
  evidence: string;
  notes: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface VerificationTickItem {
  verification_id: string;
  belief_id: string;
  belief_statement: string;
  belief_category: string;
  belief_confidence: number;
  strategy: VerificationStrategy;
  last_confirmed: string | null;
  contradiction_count: number;
}

export interface VerificationTickResult {
  items: VerificationTickItem[];
  skipped: number;       // beliefs skipped due to cooldown
  total_pending: number; // remaining after this tick
}

export interface VerificationStats {
  total: number;
  by_status: Record<VerificationStatus, number>;
  by_outcome: Record<VerificationOutcome | 'pending', number>;
  by_strategy: Record<string, number>;
  beliefs_never_verified: number;
  beliefs_verified: number;
  average_time_to_verify_hours: number | null;
  oldest_unverified_days: number | null;
}

// ── Schema ──

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS verifications (
    id TEXT PRIMARY KEY,
    belief_id TEXT NOT NULL REFERENCES beliefs(id),
    status TEXT DEFAULT 'pending'
      CHECK (status IN ('pending', 'in_progress', 'completed', 'skipped')),
    strategy TEXT DEFAULT 'manual'
      CHECK (strategy IN ('never_verified', 'staleness', 'contradiction', 'high_confidence', 'challenged', 'manual')),
    outcome TEXT
      CHECK (outcome IN ('confirmed', 'revised', 'contradicted', 'inconclusive', NULL)),
    evidence TEXT DEFAULT '[]',
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_verifications_belief ON verifications(belief_id);
  CREATE INDEX IF NOT EXISTS idx_verifications_status ON verifications(status);
`;

// ── Helpers ──

function rowToVerification(row: VerificationRow): Verification {
  return {
    ...row,
    evidence: JSON.parse(row.evidence) as string[],
  };
}

// ── Core Functions ──

/**
 * Initialize the verifications table.
 */
export function initVerifications(db: Database.Database): void {
  db.exec(SCHEMA);
}

/**
 * Manually queue a belief for adversarial review.
 * Returns the verification ID.
 */
export function createVerification(
  db: Database.Database,
  beliefId: string,
  strategy: VerificationStrategy = 'manual',
): string | undefined {
  // Resolve the belief ID (supports prefix matching)
  const resolvedBeliefId = resolveId(db, 'beliefs', beliefId);
  if (!resolvedBeliefId) return undefined;

  // Check for existing pending/in_progress verification for this belief
  const existing = db.prepare(`
    SELECT id FROM verifications
    WHERE belief_id = ? AND status IN ('pending', 'in_progress')
  `).get(resolvedBeliefId) as { id: string } | undefined;

  if (existing) return existing.id;

  const id = randomUUID();
  db.prepare(`
    INSERT INTO verifications (id, belief_id, strategy)
    VALUES (?, ?, ?)
  `).run(id, resolvedBeliefId, strategy);

  return id;
}

/**
 * Get a single verification by ID.
 */
export function getVerification(db: Database.Database, id: string): Verification | undefined {
  const resolved = resolveId(db, 'verifications', id);
  if (!resolved) return undefined;
  const row = db.prepare('SELECT * FROM verifications WHERE id = ?').get(resolved) as VerificationRow | undefined;
  return row ? rowToVerification(row) : undefined;
}

/**
 * Reclaim stale in_progress verifications.
 * If a verification was claimed but never completed (session crashed, LLM didn't follow through),
 * reset it to pending so the belief can be picked up again.
 */
function reclaimStaleVerifications(db: Database.Database, staleClaimHours: number): void {
  db.prepare(`
    UPDATE verifications
    SET status = 'pending', started_at = NULL
    WHERE status = 'in_progress'
      AND started_at < datetime('now', ? || ' hours')
  `).run(`-${staleClaimHours}`);
}

/**
 * The core tick function. Call this whenever the host has attention budget.
 *
 * 1. Claims any manually-created pending verifications
 * 2. Auto-selects overdue beliefs (up to `budget`)
 * 3. Returns items marked 'in_progress' for the host to verify
 *
 * The host does the adversarial reasoning, then calls recordVerification().
 *
 * @param budget - Max items to return (default 3)
 * @param cooldownHours - Skip beliefs verified within this window (default 24)
 */
export function verificationTick(
  db: Database.Database,
  budget: number = 3,
  cooldownHours: number = 24,
  staleClaimHours: number = 2,
): VerificationTickResult {
  const items: VerificationTickItem[] = [];
  let skipped = 0;

  // Phase 0: Reclaim stale in_progress verifications
  reclaimStaleVerifications(db, staleClaimHours);

  // Phase 1: Claim pending verifications (manually queued)
  const pending = db.prepare(`
    SELECT v.id as vid, v.belief_id, v.strategy,
           b.statement, b.category, b.confidence, b.last_confirmed, b.contradictions
    FROM verifications v
    JOIN beliefs b ON b.id = v.belief_id
    WHERE v.status = 'pending'
      AND b.status IN ('active', 'challenged')
    ORDER BY v.created_at ASC
    LIMIT ?
  `).all(budget) as Array<{
    vid: string;
    belief_id: string;
    strategy: VerificationStrategy;
    statement: string;
    category: string;
    confidence: number;
    last_confirmed: string | null;
    contradictions: string;
  }>;

  const now = new Date().toISOString();
  const claimStmt = db.prepare(`
    UPDATE verifications SET status = 'in_progress', started_at = ? WHERE id = ?
  `);

  for (const row of pending) {
    claimStmt.run(now, row.vid);
    const contradictions = JSON.parse(row.contradictions) as unknown[];
    items.push({
      verification_id: row.vid,
      belief_id: row.belief_id,
      belief_statement: row.statement,
      belief_category: row.category,
      belief_confidence: row.confidence,
      strategy: row.strategy,
      last_confirmed: row.last_confirmed,
      contradiction_count: contradictions.length,
    });
  }

  // Phase 2: Auto-select overdue beliefs if budget remains
  const remaining = budget - items.length;
  if (remaining > 0) {
    // Get IDs of beliefs that already have pending/in_progress verifications
    const activeBeliefIds = db.prepare(`
      SELECT DISTINCT belief_id FROM verifications
      WHERE status IN ('pending', 'in_progress')
    `).all() as Array<{ belief_id: string }>;
    const excludeIds = new Set(activeBeliefIds.map(r => r.belief_id));

    // Also exclude beliefs verified within cooldown window
    const recentlyVerified = db.prepare(`
      SELECT DISTINCT belief_id FROM verifications
      WHERE status = 'completed'
        AND completed_at > datetime('now', ? || ' hours')
    `).all(`-${cooldownHours}`) as Array<{ belief_id: string }>;
    for (const r of recentlyVerified) {
      excludeIds.add(r.belief_id);
    }

    // Get candidate beliefs, prioritized
    const candidates = db.prepare(`
      SELECT id, statement, category, confidence, status, last_confirmed, contradictions
      FROM beliefs
      WHERE status IN ('active', 'challenged')
      ORDER BY
        -- Priority 1: Never verified
        CASE WHEN last_confirmed IS NULL THEN 0 ELSE 1 END,
        -- Priority 2: Challenged status
        CASE WHEN status = 'challenged' THEN 0 ELSE 1 END,
        -- Priority 3: Oldest confirmation (most stale)
        COALESCE(last_confirmed, '2000-01-01') ASC,
        -- Priority 4: Highest confidence (most costly if wrong)
        confidence DESC
    `).all() as Array<{
      id: string;
      statement: string;
      category: string;
      confidence: number;
      status: string;
      last_confirmed: string | null;
      contradictions: string;
    }>;

    let added = 0;
    for (const belief of candidates) {
      if (added >= remaining) break;
      if (excludeIds.has(belief.id)) {
        skipped++;
        continue;
      }

      // Determine strategy
      const contradictions = JSON.parse(belief.contradictions) as unknown[];
      let strategy: VerificationStrategy;
      if (belief.last_confirmed === null) {
        strategy = 'never_verified';
      } else if (belief.status === 'challenged') {
        strategy = 'challenged';
      } else if (contradictions.length > 0) {
        strategy = 'contradiction';
      } else if (belief.confidence >= 0.9) {
        strategy = 'high_confidence';
      } else {
        strategy = 'staleness';
      }

      // Create verification record
      const vid = randomUUID();
      db.prepare(`
        INSERT INTO verifications (id, belief_id, strategy, status, started_at)
        VALUES (?, ?, ?, 'in_progress', ?)
      `).run(vid, belief.id, strategy, now);

      items.push({
        verification_id: vid,
        belief_id: belief.id,
        belief_statement: belief.statement,
        belief_category: belief.category,
        belief_confidence: belief.confidence,
        strategy,
        last_confirmed: belief.last_confirmed,
        contradiction_count: contradictions.length,
      });
      added++;
    }
  }

  // Count remaining pending
  const totalPending = (db.prepare(`
    SELECT COUNT(*) as c FROM verifications WHERE status = 'pending'
  `).get() as { c: number }).c;

  return { items, skipped, total_pending: totalPending };
}

/**
 * Record the result of a verification.
 * Updates the verification record and optionally the belief itself.
 *
 * @param outcome - What the adversarial review found
 * @param evidence - Supporting evidence for the conclusion
 * @param notes - Free-text notes from the reviewer
 */
export function recordVerification(
  db: Database.Database,
  verificationId: string,
  outcome: VerificationOutcome,
  evidence?: string[],
  notes?: string,
): Verification | undefined {
  const verification = getVerification(db, verificationId);
  if (!verification) return undefined;

  const now = new Date().toISOString();

  // Wrap both updates in a transaction so verification + belief stay consistent
  const txn = db.transaction(() => {
    db.prepare(`
      UPDATE verifications
      SET status = 'completed',
          outcome = ?,
          evidence = ?,
          notes = ?,
          completed_at = ?
      WHERE id = ?
    `).run(
      outcome,
      JSON.stringify(evidence ?? []),
      notes ?? null,
      now,
      verification.id,
    );

    // If confirmed, also confirm the belief (updates last_confirmed)
    if (outcome === 'confirmed') {
      const evidenceStr = evidence && evidence.length > 0
        ? `Verified via adversarial review: ${evidence[0]}`
        : 'Verified via adversarial review';
      db.prepare(`
        UPDATE beliefs
        SET last_confirmed = ?,
            evidence = json_insert(evidence, '$[#]', ?)
        WHERE id = ?
      `).run(now, evidenceStr, verification.belief_id);
    }
  });

  txn();

  return getVerification(db, verification.id);
}

/**
 * Skip a verification (e.g., belief was retired, or not enough info to verify).
 */
export function skipVerification(
  db: Database.Database,
  verificationId: string,
  reason?: string,
): void {
  const resolved = resolveId(db, 'verifications', verificationId);
  if (!resolved) return;
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE verifications
    SET status = 'skipped',
        notes = ?,
        completed_at = ?
    WHERE id = ?
  `).run(reason ?? null, now, resolved);
}

/**
 * Opportunistic verification: pick one belief that needs review.
 * Designed to be called as a side effect of any MCP tool call.
 * Returns a single item to append to tool responses, or null if nothing is due.
 *
 * Claims the item (sets in_progress) so it won't be nudged again until
 * the 2-hour stale reclaim window. The LLM should call record_verification
 * with the result, or the claim auto-expires.
 *
 * @param cooldownHours - Skip beliefs verified within this window
 * @param staleClaimHours - Reclaim abandoned in_progress items older than this
 */
export function opportunisticVerification(
  db: Database.Database,
  cooldownHours: number = 24,
  staleClaimHours: number = 2,
): { beliefId: string; statement: string; category: string; confidence: number; verificationId: string } | null {
  // Reclaim stale in_progress verifications (same logic as verificationTick Phase 0)
  // Reset to pending so the belief can be picked up again — it was never actually reviewed.
  reclaimStaleVerifications(db, staleClaimHours);

  // Get IDs of beliefs with active verifications or recently verified
  const excludeIds = new Set<string>();

  // Only exclude beliefs with active (in_progress) verifications.
  // Pending verifications (from create_verification or stale reclaims) are
  // handled by verificationTick, not opportunistic — don't block re-selection.
  const active = db.prepare(`
    SELECT DISTINCT belief_id FROM verifications
    WHERE status = 'in_progress'
  `).all() as Array<{ belief_id: string }>;
  for (const r of active) excludeIds.add(r.belief_id);

  const recent = db.prepare(`
    SELECT DISTINCT belief_id FROM verifications
    WHERE status = 'completed'
      AND completed_at > datetime('now', ? || ' hours')
  `).all(`-${cooldownHours}`) as Array<{ belief_id: string }>;
  for (const r of recent) excludeIds.add(r.belief_id);

  // Pick the highest priority belief
  const candidates = db.prepare(`
    SELECT id, statement, category, confidence, status, last_confirmed
    FROM beliefs
    WHERE status IN ('active', 'challenged')
    ORDER BY
      CASE WHEN last_confirmed IS NULL THEN 0 ELSE 1 END,
      CASE WHEN status = 'challenged' THEN 0 ELSE 1 END,
      COALESCE(last_confirmed, '2000-01-01') ASC,
      confidence DESC
    LIMIT 20
  `).all() as Array<{
    id: string;
    statement: string;
    category: string;
    confidence: number;
    status: string;
    last_confirmed: string | null;
  }>;

  for (const belief of candidates) {
    if (excludeIds.has(belief.id)) continue;

    // Determine strategy
    let strategy: VerificationStrategy;
    if (belief.last_confirmed === null) {
      strategy = 'never_verified';
    } else if (belief.status === 'challenged') {
      strategy = 'challenged';
    } else {
      strategy = 'staleness';
    }

    // Create a verification record (claimed immediately)
    const vid = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO verifications (id, belief_id, strategy, status, started_at)
      VALUES (?, ?, ?, 'in_progress', ?)
    `).run(vid, belief.id, strategy, now);

    return {
      beliefId: belief.id,
      statement: belief.statement,
      category: belief.category,
      confidence: belief.confidence,
      verificationId: vid,
    };
  }

  return null;
}

/**
 * Get verification history for a specific belief.
 */
export function getBeliefVerifications(
  db: Database.Database,
  beliefId: string,
): Verification[] {
  const resolved = resolveId(db, 'beliefs', beliefId);
  if (!resolved) return [];
  const rows = db.prepare(`
    SELECT * FROM verifications
    WHERE belief_id = ?
    ORDER BY created_at DESC
  `).all(resolved) as VerificationRow[];
  return rows.map(rowToVerification);
}

/**
 * Get comprehensive verification stats.
 */
export function verificationStatus(db: Database.Database): VerificationStats {
  const total = (db.prepare('SELECT COUNT(*) as c FROM verifications').get() as { c: number }).c;

  // By status
  const statusRows = db.prepare(
    'SELECT status, COUNT(*) as c FROM verifications GROUP BY status'
  ).all() as Array<{ status: VerificationStatus; c: number }>;
  const by_status: Record<VerificationStatus, number> = {
    pending: 0, in_progress: 0, completed: 0, skipped: 0,
  };
  for (const r of statusRows) by_status[r.status] = r.c;

  // By outcome (completed only)
  const outcomeRows = db.prepare(
    "SELECT outcome, COUNT(*) as c FROM verifications WHERE status = 'completed' GROUP BY outcome"
  ).all() as Array<{ outcome: VerificationOutcome; c: number }>;
  const by_outcome: Record<VerificationOutcome | 'pending', number> = {
    confirmed: 0, revised: 0, contradicted: 0, inconclusive: 0, pending: by_status.pending + by_status.in_progress,
  };
  for (const r of outcomeRows) by_outcome[r.outcome] = r.c;

  // By strategy
  const strategyRows = db.prepare(
    'SELECT strategy, COUNT(*) as c FROM verifications GROUP BY strategy'
  ).all() as Array<{ strategy: string; c: number }>;
  const by_strategy: Record<string, number> = {};
  for (const r of strategyRows) by_strategy[r.strategy] = r.c;

  // Belief coverage
  const totalBeliefs = (db.prepare(
    "SELECT COUNT(*) as c FROM beliefs WHERE status IN ('active', 'challenged')"
  ).get() as { c: number }).c;

  const verifiedBeliefs = (db.prepare(`
    SELECT COUNT(DISTINCT belief_id) as c FROM verifications
    WHERE status = 'completed'
  `).get() as { c: number }).c;

  // Average time to verify (completed only)
  const avgTime = db.prepare(`
    SELECT AVG(
      (julianday(completed_at) - julianday(started_at)) * 24
    ) as avg_hours
    FROM verifications
    WHERE status = 'completed' AND started_at IS NOT NULL
  `).get() as { avg_hours: number | null };

  // Oldest unverified belief
  const oldestUnverified = db.prepare(`
    SELECT MIN(
      julianday('now') - julianday(COALESCE(last_confirmed, first_recorded))
    ) as days
    FROM beliefs
    WHERE status IN ('active', 'challenged')
      AND id NOT IN (
        SELECT DISTINCT belief_id FROM verifications WHERE status = 'completed'
      )
  `).get() as { days: number | null };

  return {
    total,
    by_status,
    by_outcome,
    by_strategy,
    beliefs_never_verified: totalBeliefs - verifiedBeliefs,
    beliefs_verified: verifiedBeliefs,
    average_time_to_verify_hours: avgTime.avg_hours,
    oldest_unverified_days: oldestUnverified.days,
  };
}
