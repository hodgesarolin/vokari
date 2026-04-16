/**
 * Context Compiler for Vokari.
 *
 * Dynamically assembles a context window from epistemic data.
 * Three layers:
 * 1. MANDATORY — corrections, beliefs, positions (configurable via include flags)
 * 2. MAINTENANCE — health/status alerts when epistemic items need attention
 * 3. RELEVANCE — fills remaining budget via FTS5 search (query-driven only)
 *
 * Key properties:
 * - Budget-aware: never exceeds the character limit
 * - Deterministic base: mandatory layer is stable (cacheable)
 * - Dynamic tail: relevance layer adapts to the conversation
 * - Self-maintaining: maintenance layer surfaces overdue verifications,
 *   pending predictions, and unchallenged positions
 */

import type Database from 'better-sqlite3';
import { getContext as getCorrectionContext } from './db.js';
import { getBeliefContext } from './beliefs.js';
import { getPositionContext } from './positions.js';
import { getPendingReview } from './predictions.js';
import {
  searchKnowledge,
  getKnowledgeStats,
} from './knowledge.js';

// ── Types ──

export interface AssembleContextOpts {
  /** Max characters for the assembled context. */
  budget: number;
  /** Which epistemic modules to include. All default to true except predictions. */
  include?: {
    corrections?: boolean;  // default: true
    beliefs?: boolean;      // default: true
    positions?: boolean;    // default: true
    predictions?: boolean;  // default: false
    maintenance?: boolean;  // default: true
  };
  /** Optional query for relevance-based retrieval in the final layer. */
  query?: string;
  /** Include section headers in output (default: true). */
  headers?: boolean;
}

export interface AssembleContextResult {
  /** The compiled context string, ready for system prompt injection. */
  context: string;
  /** Breakdown of how the budget was used. */
  breakdown: {
    mandatory: number;
    maintenance: number;
    relevance: number;
    total: number;
    budget: number;
    utilizationPct: number;
  };
  /** Number of rows considered but excluded (budget). */
  excluded: number;
  /** Maintenance items found (even if not included in context due to budget). */
  maintenanceItems: MaintenanceItems;
}

/** Counts of epistemic items needing attention. */
export interface MaintenanceItems {
  beliefsNeverVerified: number;
  beliefsStale: number;
  predictionsPastDue: number;
  positionsUnchallenged: number;
  activeContradictions: number;
  total: number;
}

// ── Main API ──

/**
 * Assemble a context window from epistemic data.
 *
 * Three-layer approach:
 * 1. Mandatory: corrections + beliefs + positions (configurable)
 * 2. Maintenance: epistemic health alerts
 * 3. Relevance: fills remaining budget with search results (query-driven)
 */
export function assembleContext(
  db: Database.Database,
  opts: AssembleContextOpts,
): AssembleContextResult {
  const {
    budget,
    include = {},
    query,
    headers = true,
  } = opts;

  const includeCorrections = include.corrections ?? true;
  const includeBeliefs = include.beliefs ?? true;
  const includePositions = include.positions ?? true;
  const includePredictions = include.predictions ?? false;
  const includeMaintenance = include.maintenance ?? true;

  const sections: string[] = [];
  let usedChars = 0;
  let excluded = 0;

  /**
   * Try to add a section. Returns true if added, false if over budget.
   */
  function tryAdd(text: string): boolean {
    const separatorCost = sections.length > 0 ? 1 : 0;
    if (usedChars + text.length + separatorCost <= budget) {
      sections.push(text);
      usedChars += text.length + separatorCost;
      return true;
    }
    excluded++;
    return false;
  }

  // ── Layer 1: MANDATORY ──

  const mandatoryStart = usedChars;

  // 1a. Corrections
  if (includeCorrections) {
    const correctionBudget = Math.floor(budget * 0.4);
    const ctx = safeCall(() => getCorrectionContext(db, correctionBudget));
    if (ctx && hasContent(ctx)) {
      tryAdd(ctx);
    }
  }

  // 1b. Beliefs
  if (includeBeliefs) {
    const beliefBudget = Math.floor((budget - usedChars) * 0.4);
    const ctx = safeCall(() => getBeliefContext(db, beliefBudget));
    if (ctx && hasContent(ctx)) {
      tryAdd(`\n${ctx}\n`);
    }
  }

  // 1c. Positions
  if (includePositions) {
    const posBudget = Math.floor((budget - usedChars) * 0.5);
    const ctx = safeCall(() => getPositionContext(db, posBudget));
    if (ctx && hasContent(ctx)) {
      tryAdd(`\n${ctx}\n`);
    }
  }

  // 1d. Predictions (opt-in)
  if (includePredictions) {
    const pending = safeCall(() => getPendingReview(db)) ?? [];
    if (pending.length > 0) {
      const predLines = pending.slice(0, 10).map(p =>
        `- ${p.prediction} (${Math.round(p.confidence * 100)}%, check: ${p.check_date ?? 'unset'})`
      );
      const predText = headers
        ? `\n# Pending Predictions\n${predLines.join('\n')}\n`
        : `\n${predLines.join('\n')}\n`;
      tryAdd(predText);
    }
  }

  const mandatorySize = usedChars - mandatoryStart;

  // ── Layer 2: MAINTENANCE ──

  const maintenanceItems = getMaintenanceItems(db);
  const maintenanceStart = usedChars;

  if (includeMaintenance && maintenanceItems.total > 0) {
    const maintenanceText = formatMaintenanceSection(maintenanceItems, headers);
    tryAdd(maintenanceText);
  }

  const maintenanceSize = usedChars - maintenanceStart;

  // ── Layer 3: RELEVANCE (query-driven only) ──

  const relevanceStart = usedChars;
  const remainingBudget = budget - usedChars;

  if (remainingBudget > 200 && query) {
    // Check if knowledge table exists before searching
    const hasKnowledge = safeCall(() => {
      getKnowledgeStats(db);
      return true;
    });

    if (hasKnowledge) {
      const searchResults = searchKnowledge(db, query, { limit: 20 });

      for (const result of searchResults) {
        const text = headers
          ? `\n### [${result.type}] ${result.key ?? ''}\n${result.content}\n`
          : `\n${result.content}\n`;

        if (!tryAdd(text)) break;
      }
    }
  }

  const relevanceSize = usedChars - relevanceStart;

  return {
    context: sections.join('\n'),
    breakdown: {
      mandatory: mandatorySize,
      maintenance: maintenanceSize,
      relevance: relevanceSize,
      total: usedChars,
      budget,
      utilizationPct: budget > 0 ? Math.round((usedChars / budget) * 100) : 0,
    },
    excluded,
    maintenanceItems,
  };
}

// ── Helpers ──

/** Call a function, returning undefined if the table doesn't exist. */
function safeCall<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/**
 * Check if a context string has actual data content beyond just headers.
 * Returns false for empty or header-only blocks like "# Beliefs\n\nNo active beliefs recorded."
 */
function hasContent(text: string): boolean {
  // Strip markdown headers and whitespace
  const stripped = text
    .replace(/^#+ .+$/gm, '')
    .replace(/No active (beliefs|positions|corrections) recorded\.?/gi, '')
    .trim();
  return stripped.length > 0;
}

// ── Maintenance Layer ──

/**
 * Read-only health check: counts epistemic items needing attention.
 * No side effects — does not create verification records or modify state.
 * Gracefully returns zero counts if epistemic tables don't exist.
 */
function getMaintenanceItems(db: Database.Database): MaintenanceItems {
  /** Safe count query — returns 0 if table doesn't exist. */
  function safeCount(sql: string): number {
    try {
      return (db.prepare(sql).get() as { c: number }).c;
    } catch {
      return 0;
    }
  }

  const beliefsNeverVerified = safeCount(`
    SELECT COUNT(*) as c FROM beliefs
    WHERE status IN ('active', 'challenged')
      AND last_confirmed IS NULL
      AND id NOT IN (
        SELECT DISTINCT belief_id FROM verifications WHERE status = 'completed'
      )
  `);

  const beliefsStale = safeCount(`
    SELECT COUNT(*) as c FROM beliefs
    WHERE status IN ('active', 'challenged')
      AND last_confirmed IS NOT NULL
      AND last_confirmed <= datetime('now', '-7 days')
  `);

  const predictionsPastDue = safeCount(`
    SELECT COUNT(*) as c FROM predictions
    WHERE outcome IS NULL
      AND check_date IS NOT NULL
      AND check_date <= datetime('now')
  `);

  const positionsUnchallenged = safeCount(`
    SELECT COUNT(*) as c FROM positions
    WHERE status IN ('held', 'challenged')
      AND (
        last_challenged IS NULL
        OR last_challenged <= datetime('now', '-30 days')
      )
  `);

  const activeContradictions = safeCount(`
    SELECT COUNT(*) as c FROM beliefs
    WHERE status = 'challenged'
      AND json_array_length(contradictions) > 0
  `);

  const total = beliefsNeverVerified + beliefsStale + predictionsPastDue
    + positionsUnchallenged + activeContradictions;

  return {
    beliefsNeverVerified,
    beliefsStale,
    predictionsPastDue,
    positionsUnchallenged,
    activeContradictions,
    total,
  };
}

/**
 * Format maintenance items as a compact context section.
 */
function formatMaintenanceSection(items: MaintenanceItems, includeHeaders: boolean): string {
  const lines: string[] = [];

  if (includeHeaders) {
    lines.push('\n⚠️ **Epistemic Maintenance Needed**');
  }

  const alerts: string[] = [];
  if (items.beliefsNeverVerified > 0) {
    alerts.push(`${items.beliefsNeverVerified} belief${items.beliefsNeverVerified === 1 ? '' : 's'} never verified`);
  }
  if (items.beliefsStale > 0) {
    alerts.push(`${items.beliefsStale} belief${items.beliefsStale === 1 ? '' : 's'} stale (>7d)`);
  }
  if (items.predictionsPastDue > 0) {
    alerts.push(`${items.predictionsPastDue} prediction${items.predictionsPastDue === 1 ? '' : 's'} past check date`);
  }
  if (items.positionsUnchallenged > 0) {
    alerts.push(`${items.positionsUnchallenged} position${items.positionsUnchallenged === 1 ? '' : 's'} unchallenged (>30d)`);
  }
  if (items.activeContradictions > 0) {
    alerts.push(`${items.activeContradictions} active contradiction${items.activeContradictions === 1 ? '' : 's'}`);
  }

  lines.push(alerts.join(' · '));

  const hints: string[] = [];
  if (items.beliefsNeverVerified > 0 || items.beliefsStale > 0) {
    hints.push('`verification_tick` to review beliefs');
  }
  if (items.predictionsPastDue > 0) {
    hints.push('`pending_predictions` to resolve predictions');
  }
  if (items.positionsUnchallenged > 0) {
    hints.push('`unchallenged_positions` to challenge positions');
  }
  if (hints.length > 0) {
    lines.push('_Actions: ' + hints.join(', ') + '_');
  }

  return lines.join('\n');
}
