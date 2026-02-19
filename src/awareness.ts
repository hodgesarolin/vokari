/**
 * F7 — Context Compiler for Session Awareness
 *
 * Queries the event stream and produces a concise "awareness summary" for
 * injection into any session's system prompt. This allows each session to
 * know what other sessions are doing or have recently done.
 *
 * Design principles:
 * - Compile, don't dump: summarize into actionable awareness, not raw events.
 * - Relevance filtering: sessions can exclude themselves and filter by channel.
 * - Token budget: keep output compact. Awareness is context, not content.
 *
 * Generalized from Brain's awareness.mjs.
 */

import type Database from 'better-sqlite3';
import { getActiveSessions, getRecentEvents } from './events.js';
import type { ActiveSession, Event } from './events.js';

// ── Types ──

export interface AwarenessOpts {
  /** Session ID to exclude from the report (typically the current session). */
  excludeSessionId?: string;
  /** Current channel hint — affects which sections are included. */
  channel?: string;
  /** Maximum characters for the compiled output (default 1500). */
  maxChars?: number;
}

// ── Public API ──

/**
 * Compile an awareness context block suitable for system prompt injection.
 *
 * Includes:
 * 1. Other active sessions (started but not yet ended).
 * 2. Recently completed sessions (session_ended events in the last 2 hours).
 *
 * Returns an empty string if there is nothing to report or on any error —
 * awareness is nice-to-have, never critical.
 */
export function compileAwarenessContext(
  db: Database.Database,
  opts: AwarenessOpts = {},
): string {
  try {
    const {
      excludeSessionId = '',
      channel = 'interactive',
      maxChars = 1500,
    } = opts;
    const parts: string[] = [];

    // 1. Active sessions (excluding current)
    const activeSessions = getActiveSessions(db, 60);
    const otherActive = activeSessions.filter(
      (s) => s.sessionId !== excludeSessionId,
    );

    if (otherActive.length > 0) {
      const lines = otherActive.slice(0, 3).map((s) => {
        const age = formatAge(s.startedAt);
        const topic = s.topic ? ` discussing ${s.topic}` : '';
        const msgs =
          s.messageCount > 0 ? `, ${s.messageCount} messages` : '';
        return `- ${s.channel}: active${topic} (started ${age}${msgs})`;
      });
      if (otherActive.length > 3) {
        lines.push(`- ... and ${otherActive.length - 3} more`);
      }
      parts.push('## Active Sessions\n' + lines.join('\n'));
    }

    // 2. Recently completed sessions (last 2 hours)
    const recentEnds = getRecentEvents(db, {
      minutes: 120,
      types: ['session_ended'],
      limit: 10,
    });
    const completions = recentEnds.filter(
      (e) => e.session_id !== excludeSessionId,
    );

    if (completions.length > 0) {
      const lines = completions.slice(0, 5).map((e) => {
        const time = formatTime(e.timestamp);
        const outcome = (e.data.outcome as string) ?? 'completed';
        const summary = e.data.summary
          ? `: ${(e.data.summary as string).slice(0, 80)}`
          : '';
        return `- ${e.session_id} (${outcome}) at ${time}${summary}`;
      });
      parts.push('## Recent Completions\n' + lines.join('\n'));
    }

    // 3. Recent interactive messages — only relevant for background/cron sessions
    if (channel === 'cron' || channel === 'background') {
      const recentMsgs = getRecentEvents(db, {
        minutes: 120,
        types: ['message_received'],
        limit: 5,
      });
      const interactiveMsgs = recentMsgs.filter(
        (e) =>
          !e.session_id.startsWith('cron:') &&
          typeof e.data.summary === 'string' &&
          e.data.summary.length > 0,
      );

      if (interactiveMsgs.length > 0) {
        const lines = interactiveMsgs.slice(0, 3).map((m) => {
          const time = formatTime(m.timestamp);
          const summary = (m.data.summary as string).slice(0, 80);
          return `- ${time}: "${summary}"`;
        });
        parts.push('## Recent User Messages\n' + lines.join('\n'));
      }
    }

    // Join sections and enforce character limit
    let result = parts.join('\n\n');
    if (result.length > maxChars) {
      result = result.slice(0, maxChars - 50) + '\n[...truncated for brevity]';
    }

    return result;
  } catch (err) {
    // Awareness is nice-to-have; never break a prompt on error
    const message = err instanceof Error ? err.message : String(err);
    console.error('[awareness] Failed to compile context:', message);
    return '';
  }
}

/**
 * Get a brief one-line hint about concurrent sessions.
 *
 * Useful for quick status checks without the full compiled context.
 * Returns an empty string if no other sessions are active.
 */
export function getConcurrentSessionHint(
  db: Database.Database,
  excludeSessionId: string = '',
): string {
  try {
    const active = getActiveSessions(db, 30);
    const others = active.filter((s) => s.sessionId !== excludeSessionId);

    if (others.length === 0) return '';
    if (others.length === 1) {
      const s = others[0];
      return `Note: ${s.channel} session active (${formatAge(s.startedAt)})`;
    }
    return `Note: ${others.length} concurrent sessions active`;
  } catch {
    return '';
  }
}

// ── Formatting Helpers ──

/**
 * Format an ISO timestamp as a relative age string.
 *
 * Examples: "just now", "15m ago", "2h ago", "3d ago"
 */
export function formatAge(isoTimestamp: string): string {
  try {
    const ms = Date.now() - new Date(isoTimestamp).getTime();
    if (ms < 60_000) return 'just now';
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
    if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
    return `${Math.round(ms / 86_400_000)}d ago`;
  } catch {
    return 'recently';
  }
}

/**
 * Format an ISO timestamp as a human-readable time string.
 *
 * Example: "10:30 AM"
 */
export function formatTime(isoTimestamp: string): string {
  try {
    return new Date(isoTimestamp).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return 'recently';
  }
}
