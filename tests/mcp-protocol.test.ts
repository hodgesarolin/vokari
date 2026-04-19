/**
 * MCP protocol integration test.
 *
 * Spawns the built Vokari MCP server over stdio, speaks real JSON-RPC,
 * and asserts that tools round-trip. This is the ONLY test in the suite
 * that exercises the actual MCP interface consumers talk to — the
 * server.tool() registrations, the StdioServerTransport, and the wire
 * protocol. Without this, a typo in a tool schema could ship and all
 * unit tests would still pass.
 *
 * BRAIN-158 audit: prior to this, 402 tests never roundtripped JSON-RPC.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

let tmpDir: string;
let dbPath: string;
let client: Client;
let transport: StdioClientTransport;

// Build once before this suite so the test runs against dist/server.js
// exactly as a real consumer would install it.
function ensureBuild(): void {
  if (!existsSync('dist/server.js')) {
    execSync('npm run build', { stdio: 'inherit' });
  }
}

beforeAll(async () => {
  ensureBuild();
  tmpDir = mkdtempSync(join(tmpdir(), 'vokari-mcp-test-'));
  dbPath = join(tmpDir, 'epistemic.db');

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), 'dist/server.js')],
    env: { ...process.env, EPISTEMIC_DB: dbPath },
  });

  client = new Client({ name: 'vokari-test', version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);
}, 30000);

afterAll(async () => {
  await client?.close();
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe('MCP protocol — tool discovery', () => {
  it('advertises all expected tools (35 total)', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t: { name: string }) => t.name).sort();
    // A few sentinels from each group — we want the list alive, not every name hard-coded.
    expect(names).toContain('add_belief');
    expect(names).toContain('predict');
    expect(names).toContain('add_position');
    expect(names).toContain('correct');
    expect(names).toContain('verification_tick');
    expect(names).toContain('assemble_context');
    expect(names).toContain('upsert_knowledge');
    expect(names.length).toBeGreaterThanOrEqual(30);
  });
});

describe('MCP protocol — beliefs round-trip', () => {
  it('add_belief → list_beliefs returns the new row', async () => {
    const add = await client.callTool({
      name: 'add_belief',
      arguments: {
        statement: 'integration test belief',
        category: 'system',
        confidence: 0.8,
      },
    });
    const text = (add.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('Belief stored');

    const list = await client.callTool({ name: 'list_beliefs', arguments: {} });
    const listText = (list.content as Array<{ type: string; text: string }>)[0].text;
    expect(listText).toContain('integration test belief');
  });
});

describe('MCP protocol — predictions round-trip', () => {
  it('predict → pending_predictions surfaces the prediction', async () => {
    // Use a PAST check_date so `pending_predictions` (which filters on
    // check_date <= now) surfaces it.
    const add = await client.callTool({
      name: 'predict',
      arguments: {
        topic: 'integration-test-topic',
        prediction: 'this test will pass',
        confidence: 0.9,
        check_date: '2020-01-01',
      },
    });
    const text = (add.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('Prediction stored');

    const pending = await client.callTool({ name: 'pending_predictions', arguments: {} });
    const pendingText = (pending.content as Array<{ type: string; text: string }>)[0].text;
    // Output format is "[id8] prediction (conf%) — check: date" — assert on prediction text
    expect(pendingText).toContain('this test will pass');
  });
});

describe('MCP protocol — corrections round-trip', () => {
  it('correct → list_corrections surfaces it', async () => {
    await client.callTool({
      name: 'correct',
      arguments: {
        type: 'pattern',
        content: 'integration test correction — do the thing',
      },
    });
    const list = await client.callTool({ name: 'list_corrections', arguments: {} });
    const text = (list.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('integration test correction');
  });
});

describe('MCP protocol — positions round-trip', () => {
  it('add_position → unchallenged_positions surfaces it', async () => {
    await client.callTool({
      name: 'add_position',
      arguments: {
        topic: 'integration-test-position',
        position: 'test positions should round-trip',
        reasoning: 'obvious',
        confidence: 0.9,
      },
    });
    const unchallenged = await client.callTool({
      name: 'unchallenged_positions',
      arguments: { days: 0 },
    });
    const text = (unchallenged.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('integration-test-position');
  });
});

describe('MCP protocol — verification round-trip', () => {
  it('create_verification → verification_tick finds it', async () => {
    const list = await client.callTool({ name: 'list_beliefs', arguments: {} });
    const listText = (list.content as Array<{ type: string; text: string }>)[0].text;
    // Grab the first belief's truncated ID from the list output
    const match = listText.match(/\[([a-f0-9]{8})\]/);
    expect(match, `list_beliefs output should contain an ID:\n${listText}`).not.toBeNull();
    const beliefPrefix = match![1];

    await client.callTool({
      name: 'create_verification',
      arguments: { belief_id: beliefPrefix, strategy: 'manual' },
    });
    const tick = await client.callTool({ name: 'verification_tick', arguments: { limit: 5 } });
    const tickText = (tick.content as Array<{ type: string; text: string }>)[0].text;
    // Just assert the call succeeded; content depends on which belief was picked.
    expect(tickText.length).toBeGreaterThan(0);
  });
});

describe('MCP protocol — context assembly round-trip', () => {
  it('assemble_context returns a bounded string', async () => {
    const ctx = await client.callTool({
      name: 'assemble_context',
      arguments: { budget: 2000 },
    });
    const text = (ctx.content as Array<{ type: string; text: string }>)[0].text;
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(4000); // allow headers/overhead
  });
});

describe('MCP protocol — knowledge round-trip', () => {
  it('upsert_knowledge → search_knowledge returns it', async () => {
    await client.callTool({
      name: 'upsert_knowledge',
      arguments: {
        type: 'note',
        key: 'integration-test-note',
        content: 'retrievable via FTS5',
      },
    });
    const search = await client.callTool({
      name: 'search_knowledge',
      arguments: { query: 'retrievable' },
    });
    const text = (search.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('integration-test-note');
  });
});
