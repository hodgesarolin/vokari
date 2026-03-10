/**
 * Epistemic Digest Compiler for Vokari.
 *
 * Compiles a human-readable summary of epistemic changes over a time period.
 * This is the minimum viable L2.5 self-correction mechanism — the user reads
 * the digest and challenges anything that seems wrong.
 *
 * "Pulse tells you what happened. Vokari tells you what it thinks."
 *
 * No LLM needed — pure SQL + string templates.
 */

import type Database from 'better-sqlite3';

// ── Types ──

export interface DigestOpts {
  /** ISO date string — include changes since this date (default: 24 hours ago). */
  since?: string;
  /** Maximum characters for the digest (default: 5000). */
  budget?: number;
  /** Include calibration stats (default: true). */
  includeCalibration?: boolean;
}

export interface DigestStats {
  predictionsResolved: number;
  beliefsChanged: number;
  correctionsAdded: number;
  positionsShifted: number;
  knowledgeUpdated: number;
  totalChanges: number;
}

export interface DigestResult {
  /** The compiled digest string, ready for human consumption. */
  digest: string;
  /** Summary statistics about what changed. */
  stats: DigestStats;
  /** Knowledge entry IDs that contributed to the digest. */
  sources: string[];
}

// ── Helpers ──

interface ChangeRow {
  id: string;
  type: string;
  key: string | null;
  content: string;
  updated_at: string;
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + '...';
}

// ── Core Function ──

/**
 * Compile an epistemic digest — a human-readable summary of changes
 * to beliefs, predictions, corrections, positions, and knowledge
 * over a given time period.
 */
export function compileDigest(
  db: Database.Database,
  opts?: DigestOpts,
): DigestResult {
  const since = opts?.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const budget = opts?.budget ?? 5000;
  const includeCalibration = opts?.includeCalibration !== false;

  const sources: string[] = [];
  const stats: DigestStats = {
    predictionsResolved: 0,
    beliefsChanged: 0,
    correctionsAdded: 0,
    positionsShifted: 0,
    knowledgeUpdated: 0,
    totalChanges: 0,
  };

  // Query all knowledge entries updated since the cutoff
  const rows = db.prepare(`
    SELECT id, type, key, content, metadata, updated_at
    FROM knowledge
    WHERE updated_at > ?
    ORDER BY type, updated_at DESC
  `).all(since) as ChangeRow[];

  // Also check beliefs table for changes
  const beliefRows = db.prepare(`
    SELECT id, statement, status, confidence, contradictions, revision_history, last_confirmed
    FROM beliefs
    WHERE last_confirmed > ? OR first_recorded > ?
  `).all(since, since) as Array<{
    id: string;
    statement: string;
    status: string;
    confidence: number;
    contradictions: string;
    revision_history: string;
    last_confirmed: string | null;
  }>;

  // Check predictions for recent resolutions
  const predictionRows = db.prepare(`
    SELECT id, topic, prediction, confidence, outcome, outcome_notes, resolved_at
    FROM predictions
    WHERE resolved_at > ?
  `).all(since) as Array<{
    id: string;
    topic: string;
    prediction: string;
    confidence: number;
    outcome: string;
    outcome_notes: string;
    resolved_at: string;
  }>;

  // Check corrections for recent additions
  const correctionRows = db.prepare(`
    SELECT id, content, type, created_at
    FROM corrections
    WHERE created_at > ?
  `).all(since) as Array<{
    id: string;
    content: string;
    type: string;
    created_at: string;
  }>;

  // ── Build digest sections ──

  const sections: string[] = [];

  // 1. Predictions resolved
  if (predictionRows.length > 0) {
    stats.predictionsResolved = predictionRows.length;
    const lines = predictionRows.map(p => {
      const emoji = p.outcome === 'correct' ? '✅' : p.outcome === 'incorrect' ? '❌' : '◐';
      const conf = Math.round(p.confidence * 100);
      return `- ${emoji} **${truncate(p.topic, 50)}** (${conf}% → ${p.outcome}): ${truncate(p.prediction, 80)}`;
    });
    sections.push(`## Predictions Resolved\n${lines.join('\n')}`);
  }

  // 2. Beliefs changed (new, confirmed, contradicted, revised)
  const changedBeliefs = beliefRows.filter(b => {
    const revisions = JSON.parse(b.revision_history || '[]') as Array<{ revised_at: string }>;
    const contras = JSON.parse(b.contradictions || '[]') as Array<{ recorded_at: string }>;
    const hasRecentRevision = revisions.some(r => r.revised_at > since);
    const hasRecentContradiction = contras.some(c => c.recorded_at > since);
    return hasRecentRevision || hasRecentContradiction || (b.last_confirmed && b.last_confirmed > since);
  });

  if (changedBeliefs.length > 0) {
    stats.beliefsChanged = changedBeliefs.length;
    const lines = changedBeliefs.map(b => {
      const conf = Math.round(b.confidence * 100);
      const revisions = JSON.parse(b.revision_history || '[]') as Array<{ revised_at: string }>;
      const contras = JSON.parse(b.contradictions || '[]') as Array<{ recorded_at: string }>;
      const hasRecentRevision = revisions.some(r => r.revised_at > since);
      const hasRecentContradiction = contras.some(c => c.recorded_at > since);
      const marker = hasRecentContradiction ? ' ⚠️' : hasRecentRevision ? ' 📝' : '';
      return `- ${truncate(b.statement, 80)} (${conf}%)${marker}`;
    });
    sections.push(`## Beliefs Changed\n${lines.join('\n')}`);
  }

  // 3. Corrections added
  if (correctionRows.length > 0) {
    stats.correctionsAdded = correctionRows.length;
    const lines = correctionRows.map(c =>
      `- [${c.type}] ${truncate(c.content, 100)}`
    );
    sections.push(`## Corrections Added\n${lines.join('\n')}`);
  }

  // 4. Knowledge updated (group by type)
  const knowledgeByType = new Map<string, ChangeRow[]>();
  for (const row of rows) {
    const existing = knowledgeByType.get(row.type) ?? [];
    existing.push(row);
    knowledgeByType.set(row.type, existing);
    sources.push(row.id);
  }

  if (knowledgeByType.size > 0) {
    const typeCounts = Array.from(knowledgeByType.entries())
      .map(([type, items]) => `${type} (${items.length})`)
      .join(', ');
    stats.knowledgeUpdated = rows.length;
    sections.push(`## Knowledge Updated\n${typeCounts}`);
  }

  // 5. Calibration stats (if requested and predictions table exists)
  if (includeCalibration) {
    try {
      const calRow = db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN outcome = 'correct' THEN 1 ELSE 0 END) as correct,
          SUM(CASE WHEN outcome = 'incorrect' THEN 1 ELSE 0 END) as incorrect,
          SUM(CASE WHEN outcome = 'partial' THEN 1 ELSE 0 END) as partial
        FROM predictions
        WHERE outcome IS NOT NULL
      `).get() as { total: number; correct: number; incorrect: number; partial: number } | undefined;

      if (calRow && calRow.total > 0) {
        const accuracy = ((calRow.correct / calRow.total) * 100).toFixed(1);
        sections.push(
          `## Calibration\n` +
          `- Resolved: ${calRow.total} predictions\n` +
          `- Accuracy: ${accuracy}% (${calRow.correct}/${calRow.total})\n` +
          `- Incorrect: ${calRow.incorrect}, Partial: ${calRow.partial}`
        );
      }
    } catch {
      // predictions table may not exist — skip calibration
    }
  }

  // ── Compile ──

  stats.totalChanges = stats.predictionsResolved + stats.beliefsChanged +
    stats.correctionsAdded + stats.positionsShifted + stats.knowledgeUpdated;

  if (sections.length === 0) {
    return {
      digest: `# Epistemic Digest\n\nNo changes since ${since.split('T')[0]}.`,
      stats,
      sources,
    };
  }

  const sinceDate = since.split('T')[0];
  let digest = `# Epistemic Digest (since ${sinceDate})\n\n`;

  // Summary line
  const summaryParts: string[] = [];
  if (stats.predictionsResolved > 0) summaryParts.push(`${stats.predictionsResolved} predictions resolved`);
  if (stats.beliefsChanged > 0) summaryParts.push(`${stats.beliefsChanged} beliefs changed`);
  if (stats.correctionsAdded > 0) summaryParts.push(`${stats.correctionsAdded} corrections added`);
  if (stats.knowledgeUpdated > 0) summaryParts.push(`${stats.knowledgeUpdated} knowledge entries updated`);
  digest += summaryParts.join(' · ') + '\n\n';

  // Add sections within budget
  for (const section of sections) {
    if (digest.length + section.length + 2 > budget) break;
    digest += section + '\n\n';
  }

  return { digest: digest.trimEnd(), stats, sources };
}
