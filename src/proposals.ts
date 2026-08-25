/**
 * Memory proposals — the adjudicated write path for the knowledge store.
 *
 * The asymmetry with retrieval is deliberate: reads are scoped by the caller's authority,
 * writes are PROPOSALS that Vokari accepts, quarantines, defers, or refuses. A caller does
 * not get to decide that its write is authoritative.
 *
 * ## Why this exists
 *
 * `upsertKnowledge` documents itself as "for mutable types, overwrite on type+key match. For
 * immutable types, creates a new row." It selects `mutable` and then updates regardless — the
 * flag is read and discarded, so every type is overwritten destructively. Measured against the
 * live store on 2026-08-12, 86 rows with `mutable = 0` had `updated_at > created_at`: 52
 * research, 16 note, **7 correction**, 3 position, and 8 others. Their prior content is gone.
 * A correction silently replaced by a later write is precisely the failure append-only exists
 * to prevent.
 *
 * ## The schema obstacle, and why a partial index solves it
 *
 * `idx_knowledge_type_key` is `UNIQUE(type, key) WHERE key IS NOT NULL`, which flatly forbids
 * keeping history: two rows for one key is the whole point of append-only. Dropping the
 * uniqueness entirely would lose the real invariant. A partial unique index on
 * `(type, key) WHERE key IS NOT NULL AND superseded_by IS NULL` keeps exactly the invariant
 * that matters — one CURRENT row per key — while letting superseded rows accumulate beneath it.
 *
 * ## Trust, and why recency alone never wins
 *
 * The July fossil that outlived a correct value was the NEWER write. Ordering by `updated_at`
 * is what let it win. So supersession requires trust >= incumbent trust; a fresher row from a
 * less trusted origin is deferred for approval rather than committed.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { now } from './db.js';

// ── Vocabulary ──

/**
 * Trust tier of a proposal's origin. `owner` is Daniel; `brain` is the daemon acting on its
 * own; `distilled` passed through a summarising model; `external` came from outside.
 *
 * `legacy` is a DELTA from the frozen contract, which lists only the four above. It exists
 * because 940 of 1091 rows in the live store carry no provenance at all, and the migration has
 * to label them something. Both obvious choices are wrong: `owner` grants top trust to rows
 * that never earned it, and `external` quarantines the entire existing store, which per the
 * quarantine rule means ~940 rows of per-row owner review. `legacy` says what is true — this
 * row predates provenance — and sits at trust 0 so any real proposal supersedes it. The store
 * drains itself as genuine writes arrive rather than needing a review campaign.
 */
export type Origin = 'owner' | 'brain' | 'distilled' | 'external' | 'legacy';

export type Classification = 'public' | 'internal' | 'personal' | 'sensitive' | 'secret';

/** How fast this fact goes stale. Required — it is what a freshness sweep walks. */
export type Volatility = 'static' | 'slow' | 'volatile';

export type ProposalStatus = 'committed' | 'quarantined' | 'rejected' | 'needs_approval';

/**
 * Trust ordering. Note `legacy` at 0 rather than alongside `external`: an unprovenanced row is
 * not untrustworthy in the way scraped web content is, it is simply unattested, and it should
 * yield to anything that arrives with provenance attached.
 */
const TRUST: Record<Origin, number> = {
  owner: 4,
  brain: 3,
  distilled: 2,
  external: 1,
  legacy: 0,
};

/**
 * Origins whose rows do not enter the projection until acknowledged.
 *
 * Content that passed through a transcript may carry instructions from a web page the model
 * merely quoted, so `distilled` is quarantined alongside `external` despite feeling trusted.
 * That is not hypothetical here: on 2026-08-10 the second-brain scraper was found reading its
 * own distillation prompt back out of `~/.claude/projects` and could have laundered it into
 * the corpus as newly-observed knowledge.
 */
const QUARANTINE_ORIGINS: ReadonlySet<Origin> = new Set<Origin>(['distilled', 'external']);

/**
 * Types a proposal may never write — the sink allowlist, inverted.
 *
 * `context` holds what Brain is TOLD IT IS: the personal-context projection assembled into
 * every system prompt. A capture pipeline that can rewrite those keys can rewrite Brain's
 * instructions, so the proposal path is closed to them and projection maintainers keep their
 * own direct write path. Same reasoning excludes config and instruction keys.
 */
const DENIED_TYPES: ReadonlySet<string> = new Set(['context', 'config', 'instruction']);

const ORIGINS = new Set<string>(Object.keys(TRUST));
const CLASSIFICATIONS = new Set<string>(['public', 'internal', 'personal', 'sensitive', 'secret']);
const VOLATILITIES = new Set<string>(['static', 'slow', 'volatile']);

// ── Shapes ──

export interface MemoryProposal {
  type: string;
  key?: string;
  content: string;
  /** Where this came from, specifically enough to audit: `conversation:<id>`, `cron:<name>`. */
  source: string;
  origin: Origin;
  model?: string;
  confidence: number;
  classification: Classification;
  volatility: Volatility;
  /**
   * Required, not optional narrowing. Retrieval is topic-scoped, so a row proposed without
   * topics is invisible to every scoped read — it would be silently less than exists, which is
   * the failure the `omitted` contract exists to prevent, arriving through the write side.
   */
  topics: string[];
  /** Explicit supersession target. Omit to let key matching find the incumbent. */
  supersedes?: string;
  /** Retrieval package this proposal was derived from, for audit correlation. */
  package_id?: string;
  metadata?: Record<string, unknown>;
}

export interface Conflict {
  row_id: string;
  reason: 'content_differs' | 'owner_row_exists' | 'lower_trust_than_incumbent';
  existing_origin: Origin;
  existing_updated_at: string;
}

export interface Decision {
  status: ProposalStatus;
  row_id?: string;
  reason: string;
  conflicts: Conflict[];
}

interface CurrentRow {
  id: string;
  content: string;
  origin: string | null;
  updated_at: string;
}

// ── Migration ──

/**
 * Adds provenance columns and swaps the unique index for its partial form.
 *
 * Non-destructive: every existing row keeps its content and id, gains `origin = 'legacy'`, and
 * remains current (`superseded_by IS NULL`). The index swap is safe precisely because the old
 * unique index guarantees no duplicate `(type, key)` exists to violate the new one.
 */
export function initProposals(db: Database.Database): void {
  // Idempotent by construction rather than via `runMigration`. That helper marks a migration
  // applied when a statement fails with "duplicate column", which is the right call for a
  // single-statement migration and the wrong one here: on a database that already had some of
  // these columns, the ALTERs would abort, the migration would be recorded as done, and the
  // index swap — the part that actually enables append-only — would never run. Checking what
  // exists is cheaper than reasoning about that.
  const existing = new Set(
    (db.prepare('PRAGMA table_info(knowledge)').all() as { name: string }[]).map((c) => c.name),
  );

  const COLUMNS: [string, string][] = [
    ['origin', 'TEXT'],
    ['source', 'TEXT'],
    ['model', 'TEXT'],
    ['confidence', 'REAL'],
    ['classification', 'TEXT'],
    ['volatility', 'TEXT'],
    ['last_verified', 'TEXT'],
    ['topics', 'TEXT'],
    ['superseded_by', 'TEXT'],
    ['quarantined', 'INTEGER NOT NULL DEFAULT 0'],
    ['package_id', 'TEXT'],
  ];

  const sql = [
    ...COLUMNS
      .filter(([name]) => !existing.has(name))
      .map(([name, decl]) => `ALTER TABLE knowledge ADD COLUMN ${name} ${decl};`),

    // Every pre-existing row predates provenance. See the `legacy` note on Origin.
    "UPDATE knowledge SET origin = 'legacy' WHERE origin IS NULL;",

    // The swap. Safe in this order because the OLD unique index guarantees no duplicate
    // (type, key) exists that could violate the new one.
    'DROP INDEX IF EXISTS idx_knowledge_type_key;',
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_current
       ON knowledge(type, key) WHERE key IS NOT NULL AND superseded_by IS NULL;`,

    'CREATE INDEX IF NOT EXISTS idx_knowledge_superseded ON knowledge(superseded_by);',
    'CREATE INDEX IF NOT EXISTS idx_knowledge_quarantined ON knowledge(quarantined);',
  ].join('\n');

  db.transaction(() => db.exec(sql))();
}

// ── Validation ──

/**
 * Schema and policy checks. Returns a rejection reason, or null when the proposal is well
 * formed. Deliberately exhaustive-and-first-failure rather than collecting every problem: a
 * caller that submitted a secret should be told about the secret, not handed a list.
 */
function validate(p: MemoryProposal): string | null {
  if (!p.type || typeof p.type !== 'string') return 'type is required';

  if (DENIED_TYPES.has(p.type)) {
    return `type '${p.type}' is not writable through proposals — it holds instruction/projection state, not durable knowledge`;
  }

  if (typeof p.content !== 'string' || !p.content.trim()) return 'content is required';

  // An empty string is falsy in JS but NOT NULL in SQL, so incumbent lookup skips it while the
  // partial index still treats it as a key — the second empty-key proposal collided and threw
  // a SqliteError out of a function that is documented to return a Decision for every outcome.
  if (p.key !== undefined && (typeof p.key !== 'string' || !p.key.trim())) {
    return 'key must be a non-empty string when provided';
  }
  if (!p.source || typeof p.source !== 'string') return 'source is required for provenance';
  if (!ORIGINS.has(p.origin)) return `origin must be one of ${[...ORIGINS].join(', ')}`;

  // A caller must not be able to launder a row in as pre-attested history.
  if (p.origin === 'legacy') return "origin 'legacy' is reserved for pre-provenance rows and cannot be proposed";

  if (!CLASSIFICATIONS.has(p.classification)) {
    return `classification must be one of ${[...CLASSIFICATIONS].join(', ')}`;
  }

  // Refused, never redacted. Silently stripping the secret and committing the rest teaches the
  // caller that submitting secrets works, and the next one lands somewhere with no stripper.
  // The rejection names the destination, because a refusal without one is how the value ends
  // up pasted into a note instead.
  if (p.classification === 'secret') {
    return 'secrets are refused, not redacted — store it in the secret store (Brain: Settings → Secrets) and reference it as secret://<name>';
  }

  if (!VOLATILITIES.has(p.volatility)) return `volatility must be one of ${[...VOLATILITIES].join(', ')}`;
  if (typeof p.confidence !== 'number' || !(p.confidence >= 0 && p.confidence <= 1)) {
    return 'confidence must be a number in [0, 1]';
  }
  if (!Array.isArray(p.topics) || p.topics.length === 0 || !p.topics.every((t) => typeof t === 'string' && t.trim())) {
    return 'topics is required and must be a non-empty array of strings — a row without topics is invisible to every scoped read';
  }
  return null;
}

// ── Adjudication ──

/** Caller-supplied adjudication policy. Everything omitted keeps the built-in default. */
export interface ProposalPolicy {
  /**
   * Origins held for review instead of committing. Defaults to QUARANTINE_ORIGINS
   * ({distilled, external}). A caller enforcing a stricter regime — Brain's launch
   * policy quarantines EVERY machine origin including 'brain', with exemption
   * earned per-writer by measured accepted-rate — passes its own set per call.
   * The policy belongs to the caller: this store adjudicates mechanics
   * (conflicts, trust, supersession); who is trusted to commit unreviewed is a
   * policy-layer decision that will vary per actor over time.
   */
  quarantineOrigins?: ReadonlySet<Origin> | readonly Origin[];
}

/**
 * Submit a proposal. Nothing is ever replaced: a commit inserts a new immutable row and marks
 * the row it replaced with `superseded_by`.
 */
export function proposeMemoryWrite(
  db: Database.Database,
  p: MemoryProposal,
  policy: ProposalPolicy = {},
): Decision {
  const rejection = validate(p);
  if (rejection) return { status: 'rejected', reason: rejection, conflicts: [] };

  const quarantineOrigins: ReadonlySet<Origin> = policy.quarantineOrigins
    ? new Set(policy.quarantineOrigins)
    : QUARANTINE_ORIGINS;

  const txn = db.transaction((): Decision => {
    const ts = now();
    const conflicts: Conflict[] = [];

    // Determined by origin alone, so it is settled before anything about the incumbent is
    // consulted. Deciding it later made the same input class behave two ways: an `external`
    // proposal for a NEW key was quarantined, while one for an EXISTING key came back as
    // needs_approval — implying an owner could approve it into place without ever
    // acknowledging that it came from outside.
    const quarantined = quarantineOrigins.has(p.origin);

    // The incumbent: the current row for this key, if any. Explicit `supersedes` wins over key
    // matching so a caller can target a specific row.
    let incumbent: CurrentRow | undefined;
    if (p.supersedes) {
      incumbent = db.prepare(
        'SELECT id, content, origin, updated_at FROM knowledge WHERE id = ? AND superseded_by IS NULL',
      ).get(p.supersedes) as CurrentRow | undefined;
      if (!incumbent) {
        return {
          status: 'rejected',
          reason: `supersedes target ${p.supersedes} is not a current row`,
          conflicts: [],
        };
      }

      // The explicit target must hold the key this row will occupy. Otherwise the named row is
      // superseded, the row actually holding the key stays current, and the insert collides
      // with it — the caller's mistake surfacing as a raw SqliteError.
      if (p.key) {
        const holder = db.prepare(
          'SELECT id FROM knowledge WHERE type = ? AND key = ? AND superseded_by IS NULL',
        ).get(p.type, p.key) as { id: string } | undefined;
        if (holder && holder.id !== incumbent.id) {
          return {
            status: 'rejected',
            reason: `supersedes target ${p.supersedes} does not hold the current row for ${p.type}/${p.key}`,
            conflicts: [],
          };
        }
      }
    } else if (p.key) {
      incumbent = db.prepare(
        'SELECT id, content, origin, updated_at FROM knowledge WHERE type = ? AND key = ? AND superseded_by IS NULL',
      ).get(p.type, p.key) as CurrentRow | undefined;
    }

    if (incumbent) {
      const existingOrigin = (incumbent.origin ?? 'legacy') as Origin;
      const base = {
        row_id: incumbent.id,
        existing_origin: existingOrigin,
        existing_updated_at: incumbent.updated_at,
      };

      if (incumbent.content !== p.content) conflicts.push({ ...base, reason: 'content_differs' });

      // An owner statement is not overwritten by a machine on its own initiative, however
      // confident or recent the machine is.
      if (existingOrigin === 'owner' && p.origin !== 'owner') {
        conflicts.push({ ...base, reason: 'owner_row_exists' });
        if (!quarantined) return {
          status: 'needs_approval',
          reason: 'the current row was stated by the owner; a machine proposal cannot supersede it without approval',
          conflicts,
        };
      }

      // An incumbent whose origin is outside the vocabulary cannot be ranked, so it is not
      // auto-superseded. `TRUST[unknown]` is undefined and `n < undefined` is false, which let
      // the gate pass silently — a proposal committed straight over a row it could not compare
      // itself to. Defaulting the unknown side to 0 does not fix that: every valid proposal
      // origin is >= 1, so the comparison stays false and the write still lands. The only
      // fail-closed answer is to stop.
      if (!(existingOrigin in TRUST)) {
        conflicts.push({ ...base, reason: 'lower_trust_than_incumbent' });
        if (!quarantined) return {
          status: 'needs_approval',
          reason: `the current row's origin '${existingOrigin}' is not a known trust tier, so it cannot be ranked against '${p.origin}'`,
          conflicts,
        };
      }

      // Trust gate. This is the clause that stops recency from winning on its own.
      if (TRUST[p.origin] < TRUST[existingOrigin]) {
        conflicts.push({ ...base, reason: 'lower_trust_than_incumbent' });
        if (!quarantined) return {
          status: 'needs_approval',
          reason: `proposal origin '${p.origin}' is less trusted than the current row's '${existingOrigin}' — fresher is not sufficient`,
          conflicts,
        };
      }
    }

    const id = randomUUID();

    // Supersede BEFORE inserting. The partial unique index permits one current row per
    // (type, key), so a replacement inserted while the incumbent is still current trips the
    // constraint. Both statements are inside the same transaction, so ordering costs nothing
    // in atomicity — a failure below still rolls the supersession back.
    if (incumbent && !quarantined) {
      db.prepare('UPDATE knowledge SET superseded_by = ?, updated_at = ? WHERE id = ?')
        .run(id, ts, incumbent.id);
    }

    db.prepare(`
      INSERT INTO knowledge (
        id, type, key, content, metadata, created_at, updated_at, mutable,
        origin, source, model, confidence, classification, volatility,
        last_verified, topics, superseded_by, quarantined, package_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      id,
      p.type,
      // A quarantined row must not occupy the current slot for its key, or it would enter the
      // projection through the index rather than through acknowledgement. Holding it keyless
      // keeps it out until a graduation step assigns the key.
      quarantined ? null : (p.key ?? null),
      p.content,
      JSON.stringify({ ...(p.metadata ?? {}), ...(quarantined && p.key ? { pending_key: p.key } : {}) }),
      ts,
      ts,
      p.origin,
      p.source,
      p.model ?? null,
      p.confidence,
      p.classification,
      p.volatility,
      ts,
      JSON.stringify(p.topics),
      quarantined ? 1 : 0,
      p.package_id ?? null,
    );

    if (quarantined) {
      return {
        status: 'quarantined',
        row_id: id,
        reason: `origin '${p.origin}' is held for acknowledgement — content that passed through a model may carry instructions it merely quoted`,
        conflicts,
      };
    }

    return {
      status: 'committed',
      row_id: id,
      reason: incumbent ? `superseded ${incumbent.id}` : 'new row',
      conflicts,
    };
  });

  // IMMEDIATE, not the deferred default. `db.transaction(fn)` issues plain BEGIN, so the write
  // lock is not taken until the first write — two writers racing on one (type, key) would both
  // resolve "no incumbent" and both INSERT, and the partial unique index correctly rejects the
  // loser. That is reachable across PROCESSES here, not just within one: Brain writes this same
  // database directly through lib/vokari-client.mjs. With IMMEDIATE the loser blocks at BEGIN,
  // then re-reads and finds the winner's row.
  return txn.immediate();
}

// ── Projection ──

/**
 * The current, non-quarantined row for a key — what a read should resolve to.
 *
 * Reads from the projection rather than ordering by `updated_at`, which is the ordering that
 * let a stale July row win by being the newest write.
 */
export function currentKnowledge(
  db: Database.Database,
  type: string,
  key: string,
): { id: string; content: string; origin: Origin; updated_at: string } | undefined {
  const row = db.prepare(`
    SELECT id, content, COALESCE(origin, 'legacy') AS origin, updated_at
    FROM knowledge
    WHERE type = ? AND key = ? AND superseded_by IS NULL AND quarantined = 0
  `).get(type, key) as { id: string; content: string; origin: Origin; updated_at: string } | undefined;
  return row;
}

/**
 * Full history for a key, newest first. The thing the destructive upsert made impossible.
 */
export function knowledgeHistory(
  db: Database.Database,
  type: string,
  key: string,
): { id: string; content: string; origin: Origin; source: string | null; created_at: string; superseded_by: string | null }[] {
  return db.prepare(`
    SELECT id, content, COALESCE(origin, 'legacy') AS origin, source, created_at, superseded_by
    FROM knowledge
    WHERE type = ? AND (key = ? OR json_extract(metadata, '$.pending_key') = ?)
    ORDER BY created_at DESC
  `).all(type, key, key) as { id: string; content: string; origin: Origin; source: string | null; created_at: string; superseded_by: string | null }[];
}

/**
 * Per-type write rates, for the liveness detector.
 *
 * §7 of the contracts requires every control to have a paired detector, because each failure
 * in the August 2026 audit was a control that had silently stopped while still appearing
 * present. That section was amended on 2026-08-11 after `knowledge_access` was found dead
 * since March — and by 2026-08-12 four more types had gone to zero unnoticed: `correction`
 * (35 rows in June, none since), `handoff`, `position`, and `journal`. Counting is the whole
 * detector; the reason it kept not happening is that nothing ran it.
 */
export function writeRatesByType(
  db: Database.Database,
): { type: string; total: number; last_write: string; days_since: number }[] {
  return db.prepare(`
    SELECT type,
           COUNT(*)         AS total,
           MAX(created_at)  AS last_write,
           CAST(julianday('now') - julianday(MAX(created_at)) AS INTEGER) AS days_since
    FROM knowledge
    GROUP BY type
    ORDER BY days_since DESC
  `).all() as { type: string; total: number; last_write: string; days_since: number }[];
}
