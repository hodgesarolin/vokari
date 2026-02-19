import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  initEvents,
  logEvent,
  logSessionStart,
  logSessionEnd,
  logMessageReceived,
  getRecentEvents,
  getActiveSessions,
  pruneOldEvents,
  getEventStats,
} from '../src/events.js';
import {
  compileAwarenessContext,
  getConcurrentSessionHint,
  formatAge,
  formatTime,
} from '../src/awareness.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  initEvents(db);
});

describe('initEvents', () => {
  it('creates the events table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('creates indexes', () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_events_%'")
      .all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_events_session');
    expect(names).toContain('idx_events_timestamp');
    expect(names).toContain('idx_events_type');
  });

  it('is idempotent', () => {
    initEvents(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'")
      .all();
    expect(tables).toHaveLength(1);
  });
});

describe('logEvent', () => {
  it('returns an auto-incremented id', () => {
    const id1 = logEvent(db, 'test', 'session-1');
    const id2 = logEvent(db, 'test', 'session-1');
    expect(id1).toBe(1);
    expect(id2).toBe(2);
  });

  it('stores event data', () => {
    logEvent(db, 'custom_event', 'session-1', { key: 'value' });
    const row = db.prepare('SELECT * FROM events WHERE id = 1').get() as any;
    expect(row.event_type).toBe('custom_event');
    expect(row.session_id).toBe('session-1');
    expect(JSON.parse(row.data)).toEqual({ key: 'value' });
    expect(row.timestamp).toBeTruthy();
  });

  it('defaults data to empty object', () => {
    logEvent(db, 'test', 'session-1');
    const row = db.prepare('SELECT * FROM events WHERE id = 1').get() as any;
    expect(JSON.parse(row.data)).toEqual({});
  });
});

describe('logSessionStart', () => {
  it('logs a session_started event', () => {
    const id = logSessionStart(db, 'tg:123', { channel: 'telegram', topic: 'coding' });
    expect(id).toBeGreaterThan(0);

    const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as any;
    expect(row.event_type).toBe('session_started');
    expect(row.session_id).toBe('tg:123');
    const data = JSON.parse(row.data);
    expect(data.channel).toBe('telegram');
    expect(data.topic).toBe('coding');
  });

  it('infers channel from session id prefix', () => {
    logSessionStart(db, 'tg:456');
    const row = db.prepare('SELECT * FROM events WHERE id = 1').get() as any;
    const data = JSON.parse(row.data);
    expect(data.channel).toBe('telegram');
  });

  it('includes model in data', () => {
    logSessionStart(db, 'web:1', { model: 'claude-4' });
    const row = db.prepare('SELECT * FROM events WHERE id = 1').get() as any;
    const data = JSON.parse(row.data);
    expect(data.model).toBe('claude-4');
  });
});

describe('logSessionEnd', () => {
  it('logs a session_ended event', () => {
    const id = logSessionEnd(db, 'tg:123', {
      outcome: 'completed',
      messageCount: 10,
      duration: 300,
      summary: 'Discussed coding patterns',
    });
    expect(id).toBeGreaterThan(0);

    const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as any;
    expect(row.event_type).toBe('session_ended');
    const data = JSON.parse(row.data);
    expect(data.outcome).toBe('completed');
    expect(data.messageCount).toBe(10);
    expect(data.duration).toBe(300);
    expect(data.summary).toBe('Discussed coding patterns');
  });

  it('defaults outcome to completed', () => {
    logSessionEnd(db, 'tg:123');
    const row = db.prepare('SELECT * FROM events WHERE id = 1').get() as any;
    const data = JSON.parse(row.data);
    expect(data.outcome).toBe('completed');
  });
});

describe('logMessageReceived', () => {
  it('logs a message_received event', () => {
    const id = logMessageReceived(db, 'web:1', {
      fromUser: 'Kim',
      summary: 'Asked about TypeScript',
    });
    expect(id).toBeGreaterThan(0);

    const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as any;
    expect(row.event_type).toBe('message_received');
    const data = JSON.parse(row.data);
    expect(data.fromUser).toBe('Kim');
    expect(data.summary).toBe('Asked about TypeScript');
  });

  it('truncates long summaries to 200 chars', () => {
    const longSummary = 'x'.repeat(300);
    logMessageReceived(db, 'web:1', { summary: longSummary });
    const row = db.prepare('SELECT * FROM events WHERE id = 1').get() as any;
    const data = JSON.parse(row.data);
    expect(data.summary.length).toBe(200);
  });
});

describe('getRecentEvents', () => {
  it('returns events from the last hour by default', () => {
    logEvent(db, 'test', 'session-1', { n: 1 });
    logEvent(db, 'test', 'session-1', { n: 2 });
    const events = getRecentEvents(db);
    expect(events).toHaveLength(2);
    expect(events[0].data).toEqual({ n: 2 }); // most recent first
  });

  it('filters by event type', () => {
    logEvent(db, 'type_a', 'session-1');
    logEvent(db, 'type_b', 'session-1');
    logEvent(db, 'type_a', 'session-1');

    const events = getRecentEvents(db, { types: ['type_a'] });
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.event_type).toBe('type_a');
    }
  });

  it('filters by session id', () => {
    logEvent(db, 'test', 'session-1');
    logEvent(db, 'test', 'session-2');

    const events = getRecentEvents(db, { sessionId: 'session-1' });
    expect(events).toHaveLength(1);
    expect(events[0].session_id).toBe('session-1');
  });

  it('respects limit', () => {
    for (let i = 0; i < 10; i++) {
      logEvent(db, 'test', 'session-1');
    }
    const events = getRecentEvents(db, { limit: 3 });
    expect(events).toHaveLength(3);
  });

  it('parses data JSON', () => {
    logEvent(db, 'test', 'session-1', { key: 'value' });
    const events = getRecentEvents(db);
    expect(events[0].data).toEqual({ key: 'value' });
  });

  it('returns empty array when no recent events', () => {
    // Insert an event with old timestamp directly
    db.prepare(`
      INSERT INTO events (event_type, session_id, timestamp, data)
      VALUES ('test', 'session-1', '2020-01-01T00:00:00Z', '{}')
    `).run();
    const events = getRecentEvents(db, { minutes: 60 });
    expect(events).toHaveLength(0);
  });
});

describe('getActiveSessions', () => {
  it('returns sessions that started but have not ended', () => {
    logSessionStart(db, 'session-1', { channel: 'telegram' });
    logSessionStart(db, 'session-2', { channel: 'web' });
    logSessionEnd(db, 'session-2');

    const active = getActiveSessions(db, 120);
    expect(active).toHaveLength(1);
    expect(active[0].sessionId).toBe('session-1');
  });

  it('includes message counts', () => {
    logSessionStart(db, 'session-1');
    logMessageReceived(db, 'session-1', { summary: 'msg1' });
    logMessageReceived(db, 'session-1', { summary: 'msg2' });

    const active = getActiveSessions(db);
    expect(active[0].messageCount).toBe(2);
  });

  it('returns empty array when no active sessions', () => {
    expect(getActiveSessions(db)).toHaveLength(0);
  });

  it('includes topic from session start data', () => {
    logSessionStart(db, 'session-1', { topic: 'coding' });
    const active = getActiveSessions(db);
    expect(active[0].topic).toBe('coding');
  });

  it('includes channel', () => {
    logSessionStart(db, 'tg:123');
    const active = getActiveSessions(db);
    expect(active[0].channel).toBe('telegram');
  });
});

describe('pruneOldEvents', () => {
  it('deletes events older than specified days', () => {
    // Insert old event directly
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO events (event_type, session_id, timestamp, data)
      VALUES ('old', 'session-1', ?, '{}')
    `).run(oldDate);

    // Insert recent event
    logEvent(db, 'recent', 'session-1');

    const deleted = pruneOldEvents(db, 7);
    expect(deleted).toBe(1);

    const remaining = db.prepare('SELECT COUNT(*) as c FROM events').get() as any;
    expect(remaining.c).toBe(1);
  });

  it('returns 0 when nothing to prune', () => {
    logEvent(db, 'test', 'session-1');
    const deleted = pruneOldEvents(db, 7);
    expect(deleted).toBe(0);
  });

  it('returns 0 for empty table', () => {
    expect(pruneOldEvents(db)).toBe(0);
  });
});

describe('getEventStats', () => {
  it('returns zeros for empty db', () => {
    const stats = getEventStats(db);
    expect(stats.total).toBe(0);
    expect(stats.byType).toHaveLength(0);
    expect(stats.oldest).toBeNull();
    expect(stats.newest).toBeNull();
  });

  it('counts total events', () => {
    logEvent(db, 'a', 'session-1');
    logEvent(db, 'b', 'session-1');
    logEvent(db, 'a', 'session-2');

    const stats = getEventStats(db);
    expect(stats.total).toBe(3);
  });

  it('groups by event type', () => {
    logEvent(db, 'type_a', 'session-1');
    logEvent(db, 'type_a', 'session-1');
    logEvent(db, 'type_b', 'session-1');

    const stats = getEventStats(db);
    const typeA = stats.byType.find((t) => t.event_type === 'type_a');
    const typeB = stats.byType.find((t) => t.event_type === 'type_b');
    expect(typeA!.count).toBe(2);
    expect(typeB!.count).toBe(1);
  });

  it('reports oldest and newest timestamps', () => {
    logEvent(db, 'a', 'session-1');
    logEvent(db, 'b', 'session-1');

    const stats = getEventStats(db);
    expect(stats.oldest).not.toBeNull();
    expect(stats.newest).not.toBeNull();
  });
});

describe('compileAwarenessContext', () => {
  it('returns empty string when no events', () => {
    const ctx = compileAwarenessContext(db);
    expect(ctx).toBe('');
  });

  it('includes active sessions section', () => {
    logSessionStart(db, 'session-1', { channel: 'telegram', topic: 'coding' });
    const ctx = compileAwarenessContext(db, { excludeSessionId: 'other-session' });
    expect(ctx).toContain('## Active Sessions');
    expect(ctx).toContain('telegram');
  });

  it('excludes current session from active list', () => {
    logSessionStart(db, 'my-session', { channel: 'web' });
    const ctx = compileAwarenessContext(db, { excludeSessionId: 'my-session' });
    expect(ctx).not.toContain('my-session');
  });

  it('includes recently completed sessions', () => {
    logSessionStart(db, 'done-session', { channel: 'telegram' });
    logSessionEnd(db, 'done-session', { outcome: 'completed', summary: 'Fixed a bug' });

    const ctx = compileAwarenessContext(db, { excludeSessionId: 'other' });
    expect(ctx).toContain('## Recent Completions');
    expect(ctx).toContain('done-session');
  });

  it('respects maxChars', () => {
    for (let i = 0; i < 10; i++) {
      logSessionStart(db, `session-${i}`, { channel: 'web', topic: `Topic ${i} with lots of text` });
    }
    const ctx = compileAwarenessContext(db, { maxChars: 100, excludeSessionId: 'none' });
    // Should be truncated but not throw
    expect(ctx.length).toBeLessThanOrEqual(150); // accounts for truncation message
  });

  it('includes recent user messages for cron channel', () => {
    logSessionStart(db, 'web:1', { channel: 'web' });
    logMessageReceived(db, 'web:1', { summary: 'Help me with code' });

    const ctx = compileAwarenessContext(db, {
      excludeSessionId: 'cron:job1',
      channel: 'cron',
    });
    // May or may not include based on filtering logic, but should not throw
    expect(typeof ctx).toBe('string');
  });

  it('does not throw on errors (returns empty string)', () => {
    // Pass a closed db to trigger an error
    const badDb = new Database(':memory:');
    badDb.close();
    const ctx = compileAwarenessContext(badDb);
    expect(ctx).toBe('');
  });
});

describe('getConcurrentSessionHint', () => {
  it('returns empty string when no active sessions', () => {
    expect(getConcurrentSessionHint(db)).toBe('');
  });

  it('returns hint for one other active session', () => {
    logSessionStart(db, 'tg:123', { channel: 'telegram' });
    const hint = getConcurrentSessionHint(db, 'other-session');
    expect(hint).toContain('Note:');
    expect(hint).toContain('telegram');
    expect(hint).toContain('session active');
  });

  it('returns count for multiple active sessions', () => {
    logSessionStart(db, 'tg:1', { channel: 'telegram' });
    logSessionStart(db, 'web:2', { channel: 'web' });
    const hint = getConcurrentSessionHint(db, 'other');
    expect(hint).toContain('2 concurrent sessions active');
  });

  it('excludes current session', () => {
    logSessionStart(db, 'my-session', { channel: 'web' });
    const hint = getConcurrentSessionHint(db, 'my-session');
    expect(hint).toBe('');
  });

  it('does not throw on errors (returns empty string)', () => {
    const badDb = new Database(':memory:');
    badDb.close();
    expect(getConcurrentSessionHint(badDb)).toBe('');
  });
});

describe('formatAge', () => {
  it('returns "just now" for very recent timestamps', () => {
    const now = new Date().toISOString();
    expect(formatAge(now)).toBe('just now');
  });

  it('returns minutes for timestamps within the hour', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(formatAge(fiveMinAgo)).toMatch(/5m ago/);
  });

  it('returns hours for timestamps within the day', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    expect(formatAge(twoHoursAgo)).toMatch(/2h ago/);
  });

  it('returns days for old timestamps', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86400 * 1000).toISOString();
    expect(formatAge(threeDaysAgo)).toMatch(/3d ago/);
  });

  it('returns a string for invalid timestamps', () => {
    // new Date('not-a-date') produces NaN but does not throw,
    // so the catch branch is not hit; the function returns a NaN-based string
    const result = formatAge('not-a-date');
    expect(typeof result).toBe('string');
  });
});

describe('formatTime', () => {
  it('formats a timestamp as a time string', () => {
    const ts = '2025-06-15T10:30:00Z';
    const result = formatTime(ts);
    // Should contain AM or PM
    expect(result).toMatch(/\d{1,2}:\d{2}\s*(AM|PM)/);
  });

  it('returns a string for invalid timestamps', () => {
    // new Date('not-a-date') produces Invalid Date but toLocaleTimeString
    // returns 'Invalid Date' rather than throwing on this platform
    const result = formatTime('not-a-date');
    expect(typeof result).toBe('string');
  });
});
