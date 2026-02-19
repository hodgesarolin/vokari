/**
 * F7 — Event Stream
 *
 * SQLite-backed event stream for cross-session awareness. Each event records
 * what happened, in which session, and when — enabling any session to know
 * what other sessions are doing or have recently done.
 *
 * Generalized from Brain's events.mjs. All functions take an explicit `db`
 * parameter rather than relying on a module-level singleton.
 */

import type Database from 'better-sqlite3';

// ── Types ──

export interface Event {
  id: number;
  event_type: string;
  session_id: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface ActiveSession {
  sessionId: string;
  channel: string;
  startedAt: string;
  topic?: string;
  messageCount: number;
}

export interface RecentEventsOpts {
  minutes?: number;
  types?: string[];
  sessionId?: string;
  limit?: number;
}

export interface SessionStartOpts {
  channel?: string;
  topic?: string;
  model?: string;
}

export interface SessionEndOpts {
  outcome?: string;
  messageCount?: number;
  duration?: number;
  summary?: string;
}

export interface MessageReceivedOpts {
  fromUser?: string;
  summary?: string;
}

export interface EventStats {
  total: number;
  byType: { event_type: string; count: number }[];
  oldest: string | null;
  newest: string | null;
}

// ── Raw row types (pre-JSON parse) ──

interface EventRow {
  id: number;
  event_type: string;
  session_id: string;
  timestamp: string;
  data: string | null;
}

interface CountRow {
  cnt: number;
}

interface TypeCountRow {
  event_type: string;
  count: number;
}

interface TimestampRow {
  oldest: string | null;
}

interface NewestRow {
  newest: string | null;
}

// ── Schema ──

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    session_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    data TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
  CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
`;

// ── Initialization ──

/**
 * Create the events table and indexes if they do not already exist.
 */
export function initEvents(db: Database.Database): void {
  db.exec(SCHEMA);
}

// ── Event Logging ──

/**
 * Log an event to the event stream.
 *
 * @returns The auto-incremented event ID.
 */
export function logEvent(
  db: Database.Database,
  eventType: string,
  sessionId: string,
  data: Record<string, unknown> = {},
): number {
  const timestamp = new Date().toISOString();
  const dataJson = JSON.stringify(data);

  const result = db.prepare(`
    INSERT INTO events (event_type, session_id, timestamp, data)
    VALUES (?, ?, ?, ?)
  `).run(eventType, sessionId, timestamp, dataJson);

  return Number(result.lastInsertRowid);
}

// ── Convenience Logging ──

/**
 * Log a session_started event.
 */
export function logSessionStart(
  db: Database.Database,
  sessionId: string,
  opts: SessionStartOpts = {},
): number {
  const { channel, topic, model } = opts;
  return logEvent(db, 'session_started', sessionId, {
    channel: channel ?? inferChannel(sessionId),
    topic,
    model,
  });
}

/**
 * Log a session_ended event.
 */
export function logSessionEnd(
  db: Database.Database,
  sessionId: string,
  opts: SessionEndOpts = {},
): number {
  const { outcome, messageCount, duration, summary } = opts;
  return logEvent(db, 'session_ended', sessionId, {
    outcome: outcome ?? 'completed',
    messageCount,
    duration,
    summary,
  });
}

/**
 * Log a message_received event.
 */
export function logMessageReceived(
  db: Database.Database,
  sessionId: string,
  opts: MessageReceivedOpts = {},
): number {
  const { fromUser, summary } = opts;
  return logEvent(db, 'message_received', sessionId, {
    fromUser,
    summary: summary?.slice(0, 200),
  });
}

// ── Querying ──

/**
 * Retrieve recent events, optionally filtered by time window, event types,
 * session ID, and result limit.
 */
export function getRecentEvents(
  db: Database.Database,
  opts: RecentEventsOpts = {},
): Event[] {
  const { minutes = 60, types, sessionId, limit = 100 } = opts;

  const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  let sql = `SELECT id, event_type, session_id, timestamp, data FROM events WHERE timestamp >= ?`;
  const params: (string | number)[] = [cutoff];

  if (types && types.length > 0) {
    sql += ` AND event_type IN (${types.map(() => '?').join(',')})`;
    params.push(...types);
  }

  if (sessionId) {
    sql += ` AND session_id = ?`;
    params.push(sessionId);
  }

  sql += ` ORDER BY timestamp DESC LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as EventRow[];
  return rows.map((row) => ({
    id: row.id,
    event_type: row.event_type,
    session_id: row.session_id,
    timestamp: row.timestamp,
    data: JSON.parse(row.data ?? '{}') as Record<string, unknown>,
  }));
}

/**
 * Get currently active sessions — those with a session_started event but no
 * matching session_ended event within the lookback window.
 */
export function getActiveSessions(
  db: Database.Database,
  maxAgeMinutes: number = 120,
): ActiveSession[] {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();

  // All session starts within the window
  const starts = db.prepare(`
    SELECT session_id, timestamp, data FROM events
    WHERE event_type = 'session_started'
      AND timestamp >= ?
    ORDER BY timestamp DESC
  `).all(cutoff) as { session_id: string; timestamp: string; data: string | null }[];

  // All session ends within the window (as a set of session IDs)
  const ends = new Set(
    (db.prepare(`
      SELECT DISTINCT session_id FROM events
      WHERE event_type = 'session_ended'
        AND timestamp >= ?
    `).all(cutoff) as { session_id: string }[]).map((r) => r.session_id),
  );

  // Message counts per session within the window
  const messageCounts = new Map<string, number>();
  const messages = db.prepare(`
    SELECT session_id, COUNT(*) as cnt FROM events
    WHERE event_type = 'message_received'
      AND timestamp >= ?
    GROUP BY session_id
  `).all(cutoff) as { session_id: string; cnt: number }[];
  for (const m of messages) {
    messageCounts.set(m.session_id, m.cnt);
  }

  // Filter to sessions that started but have not ended
  const active: ActiveSession[] = [];
  const seen = new Set<string>();

  for (const start of starts) {
    if (seen.has(start.session_id)) continue;
    seen.add(start.session_id);

    if (!ends.has(start.session_id)) {
      const data = JSON.parse(start.data ?? '{}') as Record<string, unknown>;
      active.push({
        sessionId: start.session_id,
        channel: (data.channel as string) ?? inferChannel(start.session_id),
        startedAt: start.timestamp,
        topic: data.topic as string | undefined,
        messageCount: messageCounts.get(start.session_id) ?? 0,
      });
    }
  }

  return active;
}

// ── Maintenance ──

/**
 * Delete events older than the specified number of days.
 *
 * @returns The number of events deleted.
 */
export function pruneOldEvents(
  db: Database.Database,
  daysToKeep: number = 7,
): number {
  const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare(`DELETE FROM events WHERE timestamp < ?`).run(cutoff);
  return result.changes;
}

/**
 * Get aggregate statistics about the event stream.
 */
export function getEventStats(db: Database.Database): EventStats {
  const total = (db.prepare('SELECT COUNT(*) as cnt FROM events').get() as CountRow).cnt;
  const byType = db.prepare(`
    SELECT event_type, COUNT(*) as count FROM events GROUP BY event_type
  `).all() as TypeCountRow[];
  const oldest = (db.prepare('SELECT MIN(timestamp) as oldest FROM events').get() as TimestampRow).oldest;
  const newest = (db.prepare('SELECT MAX(timestamp) as newest FROM events').get() as NewestRow).newest;

  return { total, byType, oldest, newest };
}

// ── Helpers ──

function inferChannel(sessionId: string): string {
  if (sessionId.startsWith('tg:')) return 'telegram';
  if (sessionId.startsWith('web:')) return 'web';
  if (sessionId.startsWith('cron:')) return 'cron';
  return 'unknown';
}
