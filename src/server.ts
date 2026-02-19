import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  initDb, addCorrection, getCorrection, listCorrections,
  recordViolation, graduateCorrection, deleteCorrection, getContext, getStats,
} from './db.js';
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
import type { AttentionCategory } from './metacognition.js';
import { extractSignal, buildDigest, DEFAULT_NOISE_PATTERNS, DEFAULT_SIGNAL_PATTERNS } from './distill.js';

const dbPath = process.env.EPISTEMIC_DB || './epistemic.db';
const db = initDb(dbPath);

const server = new McpServer({
  name: 'epistemic',
  version: '0.2.0', // F1-F9 feature extraction
});

// ────────────────────────────────────────────
// F9 — Corrections
// ────────────────────────────────────────────

server.tool(
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

server.tool(
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

server.tool(
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

server.tool(
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

server.tool(
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

server.tool(
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

server.tool(
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

server.tool(
  'add_belief',
  'Record a belief about the user, system, world, or self',
  {
    statement: z.string().describe('The belief statement'),
    category: z.enum(['user', 'system', 'world', 'self']).optional().describe('Category (default: world)'),
    confidence: z.number().min(0).max(1).optional().describe('Confidence 0-1 (default: 0.7)'),
    source: z.string().optional().describe('Where this belief came from'),
    evidence: z.array(z.string()).optional().describe('Supporting evidence'),
    tags: z.array(z.string()).optional().describe('Tags for filtering'),
  },
  async (params) => {
    const id = addBelief(db, params);
    const belief = getBelief(db, id);
    return { content: [{ type: 'text' as const, text: `Belief stored: ${id}\n\n${belief?.category}: ${belief?.statement} (${Math.round((belief?.confidence ?? 0) * 100)}%)` }] };
  },
);

server.tool(
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

server.tool(
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

server.tool(
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

server.tool(
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

server.tool(
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

server.tool(
  'belief_context',
  'Get formatted beliefs for system prompt injection',
  { budget: z.number().optional().default(4000) },
  async (params) => {
    const ctx = getBeliefContext(db, params.budget);
    return { content: [{ type: 'text' as const, text: ctx }] };
  },
);

server.tool(
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

server.tool(
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

server.tool(
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

server.tool(
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

server.tool(
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

server.tool(
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

server.tool(
  'challenge_position',
  'Challenge an existing position — increments challenge count',
  { id: z.string().describe('Position ID') },
  async (params) => {
    challengePosition(db, params.id);
    return { content: [{ type: 'text' as const, text: `Position ${params.id.slice(0, 8)} challenged.` }] };
  },
);

server.tool(
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

server.tool(
  'position_context',
  'Get formatted positions for system prompt injection',
  { budget: z.number().optional().default(4000) },
  async (params) => {
    const ctx = getPositionContext(db, params.budget);
    return { content: [{ type: 'text' as const, text: ctx }] };
  },
);

server.tool(
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

server.tool(
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

server.tool(
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

server.tool(
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

server.tool(
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
    const allText = params.messages.map(m => m.content).join('\n');
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

server.tool(
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

server.tool(
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

server.tool(
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
// Start
// ────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
