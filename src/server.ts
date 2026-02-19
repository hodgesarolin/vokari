import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { initDb, addCorrection, getCorrection, listCorrections, recordViolation, graduateCorrection, deleteCorrection, getContext, getStats } from './db.js';

const dbPath = process.env.EPISTEMIC_DB || './epistemic.db';
const db = initDb(dbPath);

const server = new McpServer({
  name: 'epistemic',
  version: '0.1.0',
});

// --- Tools ---

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
    source: z.string().optional().describe('Where this correction came from (conversation ID, manual, etc.)'),
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
    const corrections = listCorrections(db, {
      type: params.type,
      active: params.active_only,
    });
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
  {
    id: z.string().describe('Correction ID'),
  },
  async (params) => {
    const correction = getCorrection(db, params.id);
    if (!correction) {
      return { content: [{ type: 'text' as const, text: `Correction not found: ${params.id}` }] };
    }
    recordViolation(db, params.id);
    return { content: [{ type: 'text' as const, text: `Violation recorded for: ${correction.content}` }] };
  },
);

server.tool(
  'graduate_correction',
  'Graduate (retire) a correction that is no longer needed. Only works on graduable corrections.',
  {
    id: z.string().describe('Correction ID'),
  },
  async (params) => {
    const correction = getCorrection(db, params.id);
    if (!correction) {
      return { content: [{ type: 'text' as const, text: `Correction not found: ${params.id}` }] };
    }
    if (correction.permanence !== 'graduable') {
      return { content: [{ type: 'text' as const, text: `Cannot graduate: permanence is '${correction.permanence}', not 'graduable'` }] };
    }
    graduateCorrection(db, params.id);
    return { content: [{ type: 'text' as const, text: `Graduated: ${correction.content}` }] };
  },
);

server.tool(
  'delete_correction',
  'Permanently delete a correction',
  {
    id: z.string().describe('Correction ID'),
  },
  async (params) => {
    const correction = getCorrection(db, params.id);
    if (!correction) {
      return { content: [{ type: 'text' as const, text: `Correction not found: ${params.id}` }] };
    }
    deleteCorrection(db, params.id);
    return { content: [{ type: 'text' as const, text: `Deleted: ${correction.content}` }] };
  },
);

server.tool(
  'stats',
  'Get correction store statistics — counts by type, permanence, violations',
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

// --- Resource ---

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

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
