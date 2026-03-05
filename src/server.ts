import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  initDb, addCorrection, getCorrection, listCorrections,
  recordViolation, graduateCorrection, deleteCorrection, getContext, getStats,
} from './db.js';
import {
  initKnowledge, addKnowledge, getKnowledge, getKnowledgeByKey,
  listKnowledge, updateKnowledge, upsertKnowledge, deleteKnowledge,
  searchKnowledge, getKnowledgeStats, importAllToKnowledge,
} from './knowledge.js';
import type { KnowledgeType } from './knowledge.js';
import { assembleContext } from './compiler.js';
import type { SessionType } from './compiler.js';
import {
  addBelief, getBelief, listBeliefs, checkObservation,
  recordContradiction, confirmBelief, reviseBelief, retireBelief,
  getBeliefContext, getBeliefStats,
} from './beliefs.js';
import {
  addPrediction, getPrediction, listPredictions,
  resolvePrediction, getPendingReview, getCalibration,
} from './predictions.js';
import {
  addPosition, listPositions, challengePosition,
  revisePosition, abandonPosition, getUnchallenged, getPositionContext,
} from './positions.js';
import { calibrationReport } from './calibration.js';
import {
  logEvent, getRecentEvents, getActiveSessions, getEventStats,
} from './events.js';
import { compileAwarenessContext } from './awareness.js';
import { extractBeliefs as extractLearningBeliefs, extractTopics, extractCorrections as extractLearningCorrections, extractUrls } from './learning.js';
import { analyzeCycling, analyzeAttentionBudget } from './metacognition.js';
import {
  verificationTick, createVerification, recordVerification,
  skipVerification, verificationStatus, getBeliefVerifications,
  opportunisticVerification,
} from './verification.js';
import type { VerificationOutcome, VerificationStrategy } from './verification.js';
import type { AttentionCategory } from './metacognition.js';
import { extractSignal, buildDigest, DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS } from './distill.js';
import { compileDigest } from './digest.js';

const dbPath = process.env.EPISTEMIC_DB || './epistemic.db';
const db = initDb(dbPath);
initKnowledge(db);

const server = new McpServer({
  name: 'epistemic',
  version: '0.2.1', // Opportunistic verification on every tool call
});

// ────────────────────────────────────────────
// Opportunistic verification wrapper
// ────────────────────────────────────────────

/**
 * Cooldown between opportunistic verification nudges (in hours).
 * Controls how often a verification prompt is appended to tool responses.
 * Set to 0 to nudge on every call; higher values reduce noise.
 */
const OPPORTUNISTIC_COOLDOWN_HOURS = 24;

/**
 * Minimum interval between opportunistic nudges (ms).
 * Prevents flooding if tools are called rapidly in sequence.
 */
const OPPORTUNISTIC_MIN_INTERVAL_MS = 60_000; // 1 minute
let lastOpportunisticNudge = 0;

/**
 * Tools that should NOT trigger opportunistic verification.
 * Verification tools themselves, to avoid recursive nudging.
 */
const VERIFICATION_TOOLS = new Set([
  'verification_tick', 'create_verification', 'record_verification',
  'skip_verification', 'verification_status',
]);

/**
 * Append an opportunistic verification nudge to a tool response.
 * Called after every non-verification tool handler.
 */
function appendVerificationNudge(
  result: { content: Array<{ type: 'text'; text: string }> },
): { content: Array<{ type: 'text'; text: string }> } {
  const now = Date.now();
  if (now - lastOpportunisticNudge < OPPORTUNISTIC_MIN_INTERVAL_MS) {
    return result;
  }

  try {
    const item = opportunisticVerification(db, OPPORTUNISTIC_COOLDOWN_HOURS);
    if (!item) return result;

    lastOpportunisticNudge = now;

    const nudge = [
      '',
      '---',
      `🔍 **Verification check** [${item.verificationId.slice(0, 8)}]: "${item.statement}"`,
      `   Category: ${item.category} | Confidence: ${Math.round(item.confidence * 100)}%`,
      `   → Is this still accurate? Call \`record_verification("${item.verificationId}", outcome)\` with confirmed/revised/contradicted/inconclusive.`,
    ].join('\n');

    // Append to the last text content block
    const lastContent = result.content[result.content.length - 1];
    if (lastContent && lastContent.type === 'text') {
      lastContent.text += nudge;
    }
  } catch {
    // Never let verification errors break tool responses
  }

  return result;
}

// ────────────────────────────────────────────
// Wrapped tool registration
// ────────────────────────────────────────────

/**
 * Register a tool with opportunistic verification appended to responses.
 * Verification tools are excluded to avoid recursion.
 *
 * Uses server.tool.bind() to wrap the SDK's tool registration.
 * Depends on McpServer.tool() accepting (name, description, schema, handler).
 * Tested against @modelcontextprotocol/sdk ^1.26.0.
 */
const _registerTool = server.tool.bind(server);

function tool(
  name: string,
  description: string,
  schema: Parameters<typeof server.tool>[2],
  handler: (...args: any[]) => Promise<{ content: Array<{ type: 'text'; text: string }> }>,
): void {
  if (VERIFICATION_TOOLS.has(name)) {
    // Register without wrapper
    _registerTool(name, description, schema, handler);
  } else {
    // Register with verification nudge
    _registerTool(name, description, schema, async (...args: any[]) => {
      const result = await handler(...args);
      return appendVerificationNudge(result);
    });
  }
}

// ────────────────────────────────────────────
// F9 — Corrections
// ────────────────────────────────────────────

tool(
  'correct',
  'Store a correction — something the AI got wrong and how to do it right',
  {
    type: z.enum(['fact', 'pattern', 'policy', 'technical']).describe('Category: fact (wrong data), pattern (wrong behavior), policy (scope boundary), technical (implementation)'),
    content: z.string().describe('What to do differently (imperative form)'),
    root_cause: z.string().optional().describe('Why the error happened'),
    example_bad: z.string().optional().describe('What was said wrong (DPO rejected)'),
    example_good: z.string().optional().describe('What should have been said (DPO chosen)'),
    permanence: z.enum(['never', 'conditional', 'graduable']).optional().describe('never = permanent, conditional = retire when verified, graduable = retire after streak'),
    source: z.string().optional().describe('Where this correction came from'),
  },
  async (params) => {
    const id = addCorrection(db, params);
    const correction = getCorrection(db, id);
    return {
      content: [{ type: 'text' as const, text: `Correction stored: ${id}\n\nType: ${correction?.type}\nContent: ${correction?.content}\nPermanence: ${correction?.permanence}` }],
    };
  },
);

tool(
  'get_context',
  'Get formatted corrections for system prompt injection, priority-ordered within a character budget',
  {
    budget: z.number().optional().default(4000).describe('Maximum characters for the context block'),
  },
  async (params) => {
    const context = getContext(db, params.budget);
    return { content: [{ type: 'text' as const, text: context }] };
  },
);

tool(
  'list_corrections',
  'List all corrections, optionally filtered by type',
  {
    type: z.enum(['fact', 'pattern', 'policy', 'technical']).optional().describe('Filter by correction type'),
    active_only: z.boolean().optional().default(true).describe('Only show non-graduated corrections'),
  },
  async (params) => {
    const corrections = listCorrections(db, { type: params.type, active: params.active_only });
    const text = corrections.length === 0
      ? 'No corrections found.'
      : corrections.map(c =>
          `[${c.id.slice(0, 8)}] (${c.type}) ${c.content}${c.violation_count > 0 ? ` [${c.violation_count} violations]` : ''}`
        ).join('\n');
    return { content: [{ type: 'text' as const, text }] };
  },
);

tool(
  'record_violation',
  'Record that a correction was violated — resets streak, increments count',
  { id: z.string().describe('Correction ID') },
  async (params) => {
    const correction = getCorrection(db, params.id);
    if (!correction) return { content: [{ type: 'text' as const, text: `Correction not found: ${params.id}` }] };
    recordViolation(db, params.id);
    return { content: [{ type: 'text' as const, text: `Violation recorded for: ${correction.content}` }] };
  },
);

tool(
  'graduate_correction',
  'Retire a correction that is no longer needed (graduable only)',
  { id: z.string().describe('Correction ID') },
  async (params) => {
    const correction = getCorrection(db, params.id);
    if (!correction) return { content: [{ type: 'text' as const, text: `Correction not found: ${params.id}` }] };
    if (correction.permanence !== 'graduable') return { content: [{ type: 'text' as const, text: `Cannot graduate: permanence is '${correction.permanence}'` }] };
    graduateCorrection(db, params.id);
    return { content: [{ type: 'text' as const, text: `Graduated: ${correction.content}` }] };
  },
);

tool(
  'delete_correction',
  'Permanently delete a correction',
  { id: z.string().describe('Correction ID') },
  async (params) => {
    const correction = getCorrection(db, params.id);
    if (!correction) return { content: [{ type: 'text' as const, text: `Correction not found: ${params.id}` }] };
    deleteCorrection(db, params.id);
    return { content: [{ type: 'text' as const, text: `Deleted: ${correction.content}` }] };
  },
);

tool(
  'correction_stats',
  'Get correction store statistics',
  {},
  async () => {
    const s = getStats(db);
    const text = [
      `Total: ${s.total} (${s.active} active, ${s.graduated} graduated)`,
      `By type: policy=${s.by_type.policy}, fact=${s.by_type.fact}, pattern=${s.by_type.pattern}, technical=${s.by_type.technical}`,
      `By permanence: never=${s.by_permanence.never}, conditional=${s.by_permanence.conditional}, graduable=${s.by_permanence.graduable}`,
      `Total violations: ${s.total_violations}`,
    ].join('\n');
    return { content: [{ type: 'text' as const, text }] };
  },
);

// ────────────────────────────────────────────
// F1 — Beliefs
// ────────────────────────────────────────────

tool(
  'add_belief',
  'Record a belief about the user, system, world, or self',
  {
    statement: z.string().describe('The belief statement'),
    category: z.enum(['user', 'system', 'world', 'self']).optional().describe('Category (default: world)'),
    confidence: z.number().min(0).max(1).optional().describe('Confidence 0-1 (default: 0.7)'),
    sensitivity: z.enum(['personal', 'institutional', 'approximate']).optional().describe('Numeric contradiction sensitivity: personal (5%), institutional (10%), approximate (15%, default)'),
    source: z.string().optional().describe('Where this belief came from'),
    evidence: z.array(z.string()).optional().describe('Supporting evidence'),
    tags: z.array(z.string()).optional().describe('Tags for filtering'),
  },
  async (params) => {
    const id = addBelief(db, params);
    const belief = getBelief(db, id);
    return { content: [{ type: 'text' as const, text: `Belief stored: ${id}\n\n${belief?.category}: ${belief?.statement} (${Math.round((belief?.confidence ?? 0) * 100)}%, sensitivity: ${belief?.sensitivity ?? 'approximate'})` }] };
  },
);

tool(
  'list_beliefs',
  'List beliefs, optionally filtered by category or status',
  {
    category: z.enum(['user', 'system', 'world', 'self']).optional(),
    status: z.enum(['active', 'challenged', 'revised', 'retired']).optional(),
    challenged_only: z.boolean().optional().default(false),
  },
  async (params) => {
    const beliefs = listBeliefs(db, {
      category: params.category,
      status: params.status,
      challengedOnly: params.challenged_only,
    });
    const text = beliefs.length === 0
      ? 'No beliefs found.'
      : beliefs.map(b => {
          const status = b.status !== 'active' ? ` [${b.status.toUpperCase()}]` : '';
          const contradictions = b.contradictions.length > 0 ? ` (${b.contradictions.length} contradictions)` : '';
          return `[${b.id.slice(0, 8)}] (${b.category}) ${b.statement} — ${Math.round(b.confidence * 100)}%${status}${contradictions}`;
        }).join('\n');
    return { content: [{ type: 'text' as const, text }] };
  },
);

tool(
  'check_observation',
  'Check an observation against existing beliefs for matches and contradictions',
  {
    observation: z.string().describe('The observation to check'),
    category: z.enum(['user', 'system', 'world', 'self']).optional(),
  },
  async (params) => {
    const result = checkObservation(db, params.observation, params.category);
    const parts: string[] = [];
    if (result.matches.length > 0) {
      parts.push(`**Matching beliefs (${result.matches.length}):**`);
      for (const m of result.matches.slice(0, 5)) {
        parts.push(`- ${m.belief.statement} (relevance: ${(m.relevance * 100).toFixed(0)}%)`);
      }
    }
    if (result.contradictions.length > 0) {
      parts.push(`\n**Contradictions detected (${result.contradictions.length}):**`);
      for (const c of result.contradictions) {
        parts.push(`- ${c.beliefStatement} — reason: ${c.reason}`);
      }
    }
    if (parts.length === 0) parts.push('No matching beliefs found.');
    return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
  },
);

tool(
  'contradict_belief',
  'Record a contradiction against a belief',
  {
    belief_id: z.string().describe('Belief ID'),
    observation: z.string().describe('The contradicting observation'),
    reason: z.string().optional().describe('Why this contradicts'),
  },
  async (params) => {
    const updated = recordContradiction(db, params.belief_id, params.observation, params.reason);
    if (!updated) return { content: [{ type: 'text' as const, text: `Belief not found: ${params.belief_id}` }] };
    return { content: [{ type: 'text' as const, text: `Contradiction recorded. Status: ${updated.status}, total contradictions: ${updated.contradictions.length}` }] };
  },
);

tool(
  'confirm_belief',
  'Confirm a belief with optional new evidence',
  {
    belief_id: z.string().describe('Belief ID'),
    evidence: z.string().optional().describe('New supporting evidence'),
  },
  async (params) => {
    const updated = confirmBelief(db, params.belief_id, params.evidence);
    if (!updated) return { content: [{ type: 'text' as const, text: `Belief not found: ${params.belief_id}` }] };
    return { content: [{ type: 'text' as const, text: `Confirmed: ${updated.statement} (${Math.round(updated.confidence * 100)}%)` }] };
  },
);

tool(
  'revise_belief',
  'Revise a belief with a new statement',
  {
    belief_id: z.string().describe('Belief ID'),
    new_statement: z.string().describe('Updated belief statement'),
    reason: z.string().describe('Why this revision is needed'),
    new_confidence: z.number().min(0).max(1).optional(),
  },
  async (params) => {
    const updated = reviseBelief(db, params.belief_id, params.new_statement, params.reason, params.new_confidence);
    if (!updated) return { content: [{ type: 'text' as const, text: `Belief not found: ${params.belief_id}` }] };
    return { content: [{ type: 'text' as const, text: `Revised: ${updated.statement} (${Math.round(updated.confidence * 100)}%)` }] };
  },
);

tool(
  'belief_context',
  'Get formatted beliefs for system prompt injection',
  { budget: z.number().optional().default(4000) },
  async (params) => {
    const ctx = getBeliefContext(db, params.budget);
    return { content: [{ type: 'text' as const, text: ctx }] };
  },
);

tool(
  'belief_stats',
  'Get belief store statistics',
  {},
  async () => {
    const s = getBeliefStats(db);
    const parts = [
      `Total: ${s.total}`,
      `By status: active=${s.byStatus.active}, challenged=${s.byStatus.challenged}, revised=${s.byStatus.revised}, retired=${s.byStatus.retired}`,
      `By category: user=${s.byCategory.user}, system=${s.byCategory.system}, world=${s.byCategory.world}, self=${s.byCategory.self}`,
      `Total contradictions: ${s.totalContradictions}`,
    ];
    if (s.challenged.length > 0) {
      parts.push(`\nChallenged beliefs:`);
      for (const c of s.challenged) {
        parts.push(`- ${c.statement} (${c.contradictionCount} contradictions)`);
      }
    }
    return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
  },
);

// ────────────────────────────────────────────
// F9 — Predictions
// ────────────────────────────────────────────

tool(
  'predict',
  'Make a prediction with confidence level and check date',
  {
    topic: z.string().describe('What this prediction is about'),
    prediction: z.string().describe('The prediction statement'),
    confidence: z.number().min(0).max(1).describe('Confidence 0-1'),
    reasoning: z.string().optional().describe('Why you believe this'),
    resolution_criteria: z.string().optional().describe('How to verify'),
    check_date: z.string().optional().describe('ISO date to check (e.g., 2026-03-01)'),
    domain: z.enum(['political', 'technical', 'behavioral', 'market', 'general']).optional(),
  },
  async (params) => {
    const id = addPrediction(db, params);
    const p = getPrediction(db, id);
    return { content: [{ type: 'text' as const, text: `Prediction stored: ${id}\n\n${p?.prediction} (${Math.round((p?.confidence ?? 0) * 100)}% confidence)\nDomain: ${p?.domain}\nCheck: ${p?.check_date ?? 'unset'}` }] };
  },
);

tool(
  'resolve_prediction',
  'Resolve a prediction as correct, incorrect, partial, or voided',
  {
    id: z.string().describe('Prediction ID'),
    outcome: z.enum(['correct', 'incorrect', 'partial', 'voided']),
    notes: z.string().optional().describe('Resolution notes'),
  },
  async (params) => {
    resolvePrediction(db, params.id, params.outcome, params.notes);
    return { content: [{ type: 'text' as const, text: `Prediction ${params.id.slice(0, 8)} resolved as: ${params.outcome}` }] };
  },
);

tool(
  'pending_predictions',
  'Get predictions due for review',
  {},
  async () => {
    const pending = getPendingReview(db);
    const text = pending.length === 0
      ? 'No predictions due for review.'
      : pending.map(p => `[${p.id.slice(0, 8)}] ${p.prediction} (${Math.round(p.confidence * 100)}%) — check: ${p.check_date}`).join('\n');
    return { content: [{ type: 'text' as const, text }] };
  },
);

tool(
  'calibration',
  'Get prediction calibration report — accuracy, Brier score, bias analysis',
  {},
  async () => {
    const report = calibrationReport(db);
    return { content: [{ type: 'text' as const, text: report }] };
  },
);

// ────────────────────────────────────────────
// F9 — Positions
// ────────────────────────────────────────────

tool(
  'add_position',
  'Record an epistemic position on a topic',
  {
    topic: z.string().describe('Topic of the position'),
    position: z.string().describe('Your position statement'),
    reasoning: z.string().optional(),
    evidence: z.array(z.string()).optional(),
    confidence: z.number().min(0).max(1).optional(),
    counterevidence: z.array(z.string()).optional(),
  },
  async (params) => {
    const id = addPosition(db, params);
    return { content: [{ type: 'text' as const, text: `Position stored: ${id}\n\nTopic: ${params.topic}\nPosition: ${params.position}` }] };
  },
);

tool(
  'challenge_position',
  'Challenge an existing position — increments challenge count',
  { id: z.string().describe('Position ID') },
  async (params) => {
    challengePosition(db, params.id);
    return { content: [{ type: 'text' as const, text: `Position ${params.id.slice(0, 8)} challenged.` }] };
  },
);

tool(
  'revise_position',
  'Revise an existing position with a new stance',
  {
    id: z.string().describe('Position ID'),
    new_position: z.string().describe('Updated position'),
    new_confidence: z.number().min(0).max(1).describe('Updated confidence'),
    reason: z.string().describe('Why revising'),
  },
  async (params) => {
    revisePosition(db, params.id, params.new_position, params.new_confidence, params.reason);
    return { content: [{ type: 'text' as const, text: `Position ${params.id.slice(0, 8)} revised.` }] };
  },
);

tool(
  'position_context',
  'Get formatted positions for system prompt injection',
  { budget: z.number().optional().default(4000) },
  async (params) => {
    const ctx = getPositionContext(db, params.budget);
    return { content: [{ type: 'text' as const, text: ctx }] };
  },
);

tool(
  'unchallenged_positions',
  'Get positions that haven\'t been challenged in N days',
  { days: z.number().optional().default(30) },
  async (params) => {
    const positions = getUnchallenged(db, params.days);
    const text = positions.length === 0
      ? 'No unchallenged positions found.'
      : positions.map(p => `[${p.id.slice(0, 8)}] ${p.topic}: ${p.position} (${p.status})`).join('\n');
    return { content: [{ type: 'text' as const, text }] };
  },
);

// ────────────────────────────────────────────
// F7 — Events & Awareness
// ────────────────────────────────────────────

tool(
  'log_event',
  'Log an event to the session event stream',
  {
    event_type: z.string().describe('Event type (e.g., session_started, message_received)'),
    session_id: z.string().describe('Session identifier'),
    data: z.record(z.string(), z.unknown()).optional().describe('Event data'),
  },
  async (params) => {
    const id = logEvent(db, params.event_type, params.session_id, params.data as Record<string, unknown> ?? {});
    return { content: [{ type: 'text' as const, text: `Event logged: #${id} (${params.event_type})` }] };
  },
);

tool(
  'awareness',
  'Get awareness context — active sessions, recent completions',
  {
    exclude_session: z.string().optional().describe('Session ID to exclude (current session)'),
    channel: z.string().optional().describe('Current channel (interactive, cron, background)'),
    max_chars: z.number().optional().default(1500),
  },
  async (params) => {
    const ctx = compileAwarenessContext(db, {
      excludeSessionId: params.exclude_session,
      channel: params.channel,
      maxChars: params.max_chars,
    });
    return { content: [{ type: 'text' as const, text: ctx || 'No active sessions or recent events.' }] };
  },
);

tool(
  'event_stats',
  'Get event stream statistics',
  {},
  async () => {
    const s = getEventStats(db);
    const types = s.byType.map(t => `${t.event_type}: ${t.count}`).join(', ');
    return { content: [{ type: 'text' as const, text: `Total events: ${s.total}\nBy type: ${types || 'none'}\nOldest: ${s.oldest ?? 'N/A'}\nNewest: ${s.newest ?? 'N/A'}` }] };
  },
);

// ────────────────────────────────────────────
// F2 — Learning (conversation analysis)
// ────────────────────────────────────────────

tool(
  'analyze_conversation',
  'Extract beliefs, topics, corrections, and URLs from conversation messages',
  {
    messages: z.array(z.object({
      role: z.string(),
      content: z.string(),
    })).describe('Conversation messages to analyze'),
    session_id: z.string().optional().default('unknown'),
  },
  async (params) => {
    const beliefs = extractLearningBeliefs(params.messages, params.session_id);
    const topics = extractTopics(params.messages);
    const corrections = extractLearningCorrections(params.messages);
    const allText = params.messages.map((m: { role: string; content: string }) => m.content).join('\n');
    const urls = extractUrls(allText);

    const parts: string[] = [];
    if (beliefs.length > 0) {
      parts.push(`**Beliefs extracted (${beliefs.length}):**`);
      for (const b of beliefs) parts.push(`- [${b.category}] ${b.statement} (${Math.round(b.confidence * 100)}%)`);
    }
    if (topics.length > 0) {
      parts.push(`\n**Key topics:** ${topics.map(t => `${t.word} (${t.count}x)`).join(', ')}`);
    }
    if (corrections.length > 0) {
      parts.push(`\n**Corrections detected (${corrections.length}):**`);
      for (const c of corrections) parts.push(`- [${c.type}] ${c.content}`);
    }
    if (urls.length > 0) {
      parts.push(`\n**URLs:** ${urls.join(', ')}`);
    }
    if (parts.length === 0) parts.push('No signals extracted from this conversation.');

    return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
  },
);

// ────────────────────────────────────────────
// F3+F4 — Metacognition
// ────────────────────────────────────────────

tool(
  'check_cycling',
  'Analyze entries for cycling/repetitive thinking patterns',
  {
    entries: z.array(z.object({
      id: z.string(),
      title: z.string(),
      content: z.string(),
      timestamp: z.string(),
    })).describe('Text entries to analyze (most recent first)'),
    sessions_back: z.number().optional().default(5),
  },
  async (params) => {
    const analysis = analyzeCycling(params.entries, { sessionsBack: params.sessions_back });
    const parts = [
      `Cycling score: ${(analysis.score * 100).toFixed(0)}%`,
      `Entries analyzed: ${analysis.entriesAnalyzed}`,
    ];
    if (analysis.signals.length > 0) {
      parts.push(`\nSignals:`);
      for (const s of analysis.signals) parts.push(`- [${s.severity}] ${s.type}: ${s.description}`);
    }
    if (analysis.recommendation) {
      parts.push(`\nRecommendation:\n${analysis.recommendation}`);
    }
    return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
  },
);

tool(
  'check_attention',
  'Analyze attention budget across entries against priority categories',
  {
    entries: z.array(z.object({
      id: z.string(),
      title: z.string(),
      content: z.string(),
      timestamp: z.string(),
    })).describe('Text entries to analyze'),
    categories: z.record(z.string(), z.object({
      weight: z.number(),
      keywords: z.array(z.string()),
      label: z.string(),
    })).describe('Priority categories with weights and keywords'),
  },
  async (params) => {
    const categories = params.categories as Record<string, AttentionCategory>;
    const analysis = analyzeAttentionBudget(params.entries, categories);
    const parts = [
      `Alignment score: ${(analysis.alignmentScore * 100).toFixed(0)}%`,
      `Entries analyzed: ${analysis.entriesAnalyzed}`,
    ];
    if (Object.keys(analysis.breakdown).length > 0) {
      parts.push(`\nBreakdown:`);
      for (const [cat, pct] of Object.entries(analysis.breakdown)) {
        parts.push(`- ${cat}: ${(pct * 100).toFixed(1)}%`);
      }
    }
    if (analysis.alerts.length > 0) {
      parts.push(`\nAlerts:`);
      for (const a of analysis.alerts) parts.push(`- [${a.severity}] ${a.message}`);
    }
    return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
  },
);

// ────────────────────────────────────────────
// F5 — Distillation
// ────────────────────────────────────────────

tool(
  'distill',
  'Extract signal from noise in log content',
  {
    content: z.string().describe('Raw log content to distill'),
    title: z.string().optional().default('Log'),
  },
  async (params) => {
    const digest = buildDigest(params.title, params.content, DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS);
    return { content: [{ type: 'text' as const, text: digest }] };
  },
);

// ────────────────────────────────────────────
// L2.5 — Epistemic Digest
// ────────────────────────────────────────────

tool(
  'compile_digest',
  'Compile an epistemic digest — a human-readable summary of changes to beliefs, predictions, corrections, positions, and knowledge over a given time period. No LLM needed — pure SQL + string templates.',
  {
    since: z.string().optional().describe('ISO date string — include changes since this date (default: 24 hours ago)'),
    budget: z.number().optional().default(5000).describe('Maximum characters for the digest (default: 5000)'),
    include_calibration: z.boolean().optional().default(true).describe('Include calibration stats (default: true)'),
  },
  async (params) => {
    const result = compileDigest(db, {
      since: params.since,
      budget: params.budget,
      includeCalibration: params.include_calibration,
    });
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          digest: result.digest,
          stats: result.stats,
          source_count: result.sources.length,
        }, null, 2),
      }],
    };
  },
);

// ────────────────────────────────────────────
// F9 — Adversarial Verification
// ────────────────────────────────────────────

tool(
  'verification_tick',
  'Get beliefs due for adversarial review. Call this whenever you have attention budget. Returns prioritized items — verify them, then call record_verification with results.',
  {
    budget: z.number().optional().default(3).describe('Max items to return (default 3)'),
    cooldown_hours: z.number().optional().default(24).describe('Skip beliefs verified within this window (default 24h)'),
  },
  async (params) => {
    const result = verificationTick(db, params.budget, params.cooldown_hours);
    if (result.items.length === 0) {
      return { content: [{ type: 'text' as const, text: `No beliefs due for verification. ${result.skipped} skipped (recently verified). ${result.total_pending} pending.` }] };
    }
    const lines = result.items.map(item => [
      `**[${item.verification_id.slice(0, 8)}]** ${item.belief_statement}`,
      `  Category: ${item.belief_category} | Confidence: ${Math.round(item.belief_confidence * 100)}% | Strategy: ${item.strategy}`,
      `  Last confirmed: ${item.last_confirmed ?? 'never'} | Contradictions: ${item.contradiction_count}`,
      `  → Challenge this belief. Try to find evidence it's wrong. Then call record_verification.`,
    ].join('\n'));
    const summary = `\n\n---\n${result.items.length} items claimed. ${result.skipped} skipped. ${result.total_pending} still pending.`;
    return { content: [{ type: 'text' as const, text: lines.join('\n\n') + summary }] };
  },
);

tool(
  'create_verification',
  'Manually queue a specific belief for adversarial review',
  {
    belief_id: z.string().describe('Belief ID to verify'),
    strategy: z.enum(['never_verified', 'staleness', 'contradiction', 'high_confidence', 'challenged', 'manual']).optional().default('manual'),
  },
  async (params) => {
    const id = createVerification(db, params.belief_id, params.strategy as VerificationStrategy);
    return { content: [{ type: 'text' as const, text: `Verification queued: ${id.slice(0, 8)} for belief ${params.belief_id.slice(0, 8)}` }] };
  },
);

tool(
  'record_verification',
  'Record the result of an adversarial review. Call after verification_tick returns items and you have challenged the belief.',
  {
    verification_id: z.string().describe('Verification ID from verification_tick'),
    outcome: z.enum(['confirmed', 'revised', 'contradicted', 'inconclusive']).describe('What the review found'),
    evidence: z.array(z.string()).optional().describe('Evidence supporting the conclusion'),
    notes: z.string().optional().describe('Free-text notes from the review'),
  },
  async (params) => {
    const result = recordVerification(db, params.verification_id, params.outcome as VerificationOutcome, params.evidence, params.notes);
    if (!result) return { content: [{ type: 'text' as const, text: `Verification not found: ${params.verification_id}` }] };
    return { content: [{ type: 'text' as const, text: `Verification ${params.verification_id.slice(0, 8)} completed: ${params.outcome}${params.notes ? ` — ${params.notes}` : ''}` }] };
  },
);

tool(
  'skip_verification',
  'Skip a verification that cannot be completed (e.g., belief retired, insufficient context). Releases the item so the belief can be picked up again after cooldown.',
  {
    verification_id: z.string().describe('Verification ID from verification_tick'),
    reason: z.string().optional().describe('Why the verification was skipped'),
  },
  async (params) => {
    skipVerification(db, params.verification_id, params.reason);
    return { content: [{ type: 'text' as const, text: `Verification ${params.verification_id.slice(0, 8)} skipped${params.reason ? `: ${params.reason}` : ''}` }] };
  },
);

tool(
  'verification_status',
  'Get adversarial verification statistics — coverage, outcomes, staleness',
  {},
  async () => {
    const s = verificationStatus(db);
    const parts = [
      `Total verifications: ${s.total}`,
      `By status: pending=${s.by_status.pending}, in_progress=${s.by_status.in_progress}, completed=${s.by_status.completed}, skipped=${s.by_status.skipped}`,
      `By outcome: confirmed=${s.by_outcome.confirmed}, revised=${s.by_outcome.revised}, contradicted=${s.by_outcome.contradicted}, inconclusive=${s.by_outcome.inconclusive}`,
      `Belief coverage: ${s.beliefs_verified} verified, ${s.beliefs_never_verified} never verified`,
    ];
    if (s.average_time_to_verify_hours !== null) {
      parts.push(`Average verify time: ${s.average_time_to_verify_hours.toFixed(1)}h`);
    }
    if (s.oldest_unverified_days !== null) {
      parts.push(`Oldest unverified: ${s.oldest_unverified_days.toFixed(1)} days`);
    }
    if (Object.keys(s.by_strategy).length > 0) {
      parts.push(`By strategy: ${Object.entries(s.by_strategy).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }
    return { content: [{ type: 'text' as const, text: parts.join('\n') }] };
  },
);

// ────────────────────────────────────────────
// Unified context resource
// ────────────────────────────────────────────

server.resource(
  'corrections-context',
  'epistemic://context',
  { description: 'Active corrections formatted for system prompt injection', mimeType: 'text/markdown' },
  async (uri) => ({
    contents: [{
      uri: uri.href,
      text: getContext(db),
      mimeType: 'text/markdown',
    }],
  }),
);

server.resource(
  'beliefs-context',
  'epistemic://beliefs',
  { description: 'Active beliefs formatted for system prompt injection', mimeType: 'text/markdown' },
  async (uri) => ({
    contents: [{
      uri: uri.href,
      text: getBeliefContext(db),
      mimeType: 'text/markdown',
    }],
  }),
);

server.resource(
  'positions-context',
  'epistemic://positions',
  { description: 'Active positions formatted for system prompt injection', mimeType: 'text/markdown' },
  async (uri) => ({
    contents: [{
      uri: uri.href,
      text: getPositionContext(db),
      mimeType: 'text/markdown',
    }],
  }),
);

// ────────────────────────────────────────────
// Unified Knowledge Store
// ────────────────────────────────────────────

const KNOWLEDGE_TYPES = [
  'belief', 'correction', 'position', 'prediction', 'research',
  'handoff', 'context', 'archive', 'daily', 'transcript',
  'session', 'ticket', 'digest',
] as const;

tool(
  'upsert_knowledge',
  'Add or update a knowledge entry. For mutable types (handoff, context), overwrites on type+key match. For other types, creates a new entry or updates existing on key match.',
  {
    type: z.enum(KNOWLEDGE_TYPES).describe('Content type'),
    key: z.string().describe('Unique key within type (e.g., "interactive-context", "family")'),
    content: z.string().describe('The content text'),
    metadata: z.record(z.string(), z.unknown()).optional().describe('Optional JSON metadata'),
  },
  async (params) => {
    const id = upsertKnowledge(db, {
      type: params.type as KnowledgeType,
      key: params.key,
      content: params.content,
      metadata: params.metadata as Record<string, unknown>,
    });
    const k = getKnowledge(db, id);
    return {
      content: [{
        type: 'text' as const,
        text: `Knowledge upserted: ${id.slice(0, 8)} (${k?.type}/${k?.key})\nMutable: ${k?.mutable}\nContent: ${k?.content.slice(0, 200)}${(k?.content.length ?? 0) > 200 ? '...' : ''}`,
      }],
    };
  },
);

tool(
  'get_knowledge',
  'Get a knowledge entry by type and key',
  {
    type: z.enum(KNOWLEDGE_TYPES).describe('Content type'),
    key: z.string().describe('Unique key within type'),
  },
  async (params) => {
    const k = getKnowledgeByKey(db, params.type as KnowledgeType, params.key);
    if (!k) return { content: [{ type: 'text' as const, text: `Not found: ${params.type}/${params.key}` }] };
    return {
      content: [{
        type: 'text' as const,
        text: `[${k.type}/${k.key}] (${k.mutable ? 'mutable' : 'immutable'})\nUpdated: ${k.updated_at}\nMetadata: ${JSON.stringify(k.metadata).slice(0, 200)}\n\n${k.content}`,
      }],
    };
  },
);

tool(
  'search_knowledge',
  'Full-text search across all knowledge types. Uses FTS5 BM25 ranking.',
  {
    query: z.string().describe('Search terms'),
    type: z.enum(KNOWLEDGE_TYPES).optional().describe('Filter by type'),
    limit: z.number().optional().default(10).describe('Max results'),
  },
  async (params) => {
    const results = searchKnowledge(db, params.query, {
      type: params.type as KnowledgeType | undefined,
      limit: params.limit,
    });
    if (results.length === 0) return { content: [{ type: 'text' as const, text: 'No results found.' }] };
    const lines = results.map((r, i) =>
      `${i + 1}. [${r.type}${r.key ? `/${r.key}` : ''}] ${r.snippet.replace(/<\/?b>/g, '**')}`
    );
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
);

tool(
  'list_knowledge',
  'List knowledge entries, optionally filtered by type',
  {
    type: z.enum(KNOWLEDGE_TYPES).optional().describe('Filter by type'),
    mutable: z.boolean().optional().describe('Filter by mutability'),
    limit: z.number().optional().default(20).describe('Max results'),
  },
  async (params) => {
    const items = listKnowledge(db, {
      type: params.type as KnowledgeType | undefined,
      mutable: params.mutable,
      limit: params.limit,
    });
    if (items.length === 0) return { content: [{ type: 'text' as const, text: 'No knowledge entries found.' }] };
    const lines = items.map(k =>
      `[${k.id.slice(0, 8)}] ${k.type}${k.key ? `/${k.key}` : ''} (${k.mutable ? 'mutable' : 'immutable'}) — ${k.content.slice(0, 80)}${k.content.length > 80 ? '...' : ''}`
    );
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
);

tool(
  'assemble_context',
  'Compile a context window from the knowledge store. Four layers: mandatory (corrections/identity), maintenance (epistemic health alerts), session (varies by type), relevance (search-based).',
  {
    budget: z.number().describe('Max characters for the context window'),
    session_type: z.enum(['interactive', 'cron_thinking', 'cron_digest', 'cron_health']).describe('Session type determines which knowledge is included'),
    query: z.string().optional().describe('Optional query for relevance-based retrieval'),
    headers: z.boolean().optional().default(true).describe('Include section headers'),
  },
  async (params) => {
    const result = assembleContext(db, {
      budget: params.budget,
      sessionType: params.session_type as SessionType,
      query: params.query,
      headers: params.headers,
    });
    const maintenanceNote = result.maintenanceItems.total > 0
      ? ` | Maintenance: ${result.breakdown.maintenance} (${result.maintenanceItems.total} items)`
      : '';
    const summary = [
      `Budget: ${result.breakdown.total}/${result.breakdown.budget} chars (${result.breakdown.utilizationPct}%)`,
      `Mandatory: ${result.breakdown.mandatory} | Session: ${result.breakdown.session} | Relevance: ${result.breakdown.relevance}${maintenanceNote}`,
      `Included: ${result.includedIds.length} entries | Excluded: ${result.excluded}`,
      '---',
      result.context,
    ].join('\n');
    return { content: [{ type: 'text' as const, text: summary }] };
  },
);

tool(
  'knowledge_stats',
  'Get statistics about the unified knowledge store',
  {},
  async () => {
    const stats = getKnowledgeStats(db);
    const types = stats.byType.map(t => `${t.type}: ${t.count}`).join(', ');
    return {
      content: [{
        type: 'text' as const,
        text: `Total: ${stats.total} entries\nMutable: ${stats.mutableCount}\nBy type: ${types || 'none'}`,
      }],
    };
  },
);

tool(
  'import_to_knowledge',
  'Import existing beliefs, corrections, positions, and predictions into the unified knowledge store. Safe to run multiple times (uses INSERT OR IGNORE).',
  {},
  async () => {
    const result = importAllToKnowledge(db);
    return {
      content: [{
        type: 'text' as const,
        text: `Imported ${result.total} entries:\n- Beliefs: ${result.beliefs}\n- Corrections: ${result.corrections}\n- Positions: ${result.positions}\n- Predictions: ${result.predictions}`,
      }],
    };
  },
);

tool(
  'upsert_handoff',
  'Write or update a handoff document (mutable). Convenience wrapper for upsert_knowledge with type=handoff.',
  {
    key: z.string().describe('Handoff key (e.g., "interactive-context", "last-session-handoff", "nightly-state", "daily-todos")'),
    content: z.string().describe('The handoff content'),
    metadata: z.record(z.string(), z.unknown()).optional().describe('Optional metadata'),
  },
  async (params) => {
    const id = upsertKnowledge(db, {
      type: 'handoff',
      key: params.key,
      content: params.content,
      metadata: params.metadata as Record<string, unknown>,
    });
    return {
      content: [{
        type: 'text' as const,
        text: `Handoff upserted: ${params.key} (${id.slice(0, 8)})\nLength: ${params.content.length} chars`,
      }],
    };
  },
);

tool(
  'get_handoff',
  'Read a handoff document by key. Returns the latest content.',
  {
    key: z.string().describe('Handoff key'),
  },
  async (params) => {
    const k = getKnowledgeByKey(db, 'handoff', params.key);
    if (!k) return { content: [{ type: 'text' as const, text: `Handoff not found: ${params.key}` }] };
    return {
      content: [{
        type: 'text' as const,
        text: `[handoff/${params.key}] Updated: ${k.updated_at}\n\n${k.content}`,
      }],
    };
  },
);

// Knowledge context resource
server.resource(
  'knowledge-context',
  'epistemic://knowledge',
  { description: 'Assembled context from unified knowledge store', mimeType: 'text/markdown' },
  async (uri) => {
    const result = assembleContext(db, {
      budget: 50000,
      sessionType: 'interactive',
    });
    return {
      contents: [{
        uri: uri.href,
        text: result.context,
        mimeType: 'text/markdown',
      }],
    };
  },
);

// ────────────────────────────────────────────
// Start
// ────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
