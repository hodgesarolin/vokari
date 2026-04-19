# Vokari

**The black box for your AI agent.** Tracks what the agent claimed, how confident it was, whether it was right, and whether it's learning — via the Model Context Protocol (MCP).

Local SQLite. Three npm dependencies. No cloud, no embeddings, no LLM calls from inside Vokari. You bring the agent; Vokari does the bookkeeping.

## 30-Second Quickstart

```bash
npx -y @vokari/epistemic init
npx -y @vokari/epistemic serve --dashboard
# Open http://localhost:3838
```

Add to your MCP client config (Claude Code, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "vokari": {
      "command": "npx",
      "args": ["-y", "@vokari/epistemic", "serve"],
      "env": {
        "EPISTEMIC_DB": "./epistemic.db"
      }
    }
  }
}
```

## Category

Vokari is a **local epistemic-state sidecar** for agents. It's not a memory retrieval system (that's Mem0, Zep, Letta, Graphiti); it's not an eval/observability platform (that's Phoenix, LangSmith, Inspect AI). It sits next to both.

| Category | Example | What it does |
|----------|---------|--------------|
| Memory retrieval | Mem0, Zep, Letta, Graphiti | Remembers what users said; retrieves with embeddings/graphs |
| Eval / observability | Phoenix, LangSmith, Inspect AI | Evaluates runs and traces after the fact |
| **Epistemic sidecar** | **Vokari** | **Tracks live agent beliefs, predictions, corrections, calibration — in-process, continuous** |

The pitches:
- Mem0 remembers what users said.
- Phoenix grades what already ran.
- **Vokari records what the agent is committing to right now, and whether it was wrong.**

## Core Concepts

**Beliefs** — Factual claims the agent holds about users, systems, the world, or itself. Each tracks confidence (0-1), evidence, contradictions, and revision history. Automatic contradiction detection via word overlap, negation, and numeric sensitivity thresholds.

**Predictions** — Explicit forecasts with confidence levels, check dates, and resolution criteria. Resolved as correct/incorrect/partial. Brier scores and calibration curves reveal whether "80% confident" actually means 80%.

**Positions** — Epistemic stances on topics with reasoning, evidence, and counterevidence. Challenge stale positions. Track how thinking evolves through revision history.

**Corrections** — Behavioral error tracking with streaks, graduation, and violation detection. The most battle-tested module — 35 active corrections driving real behavioral change in production.

**Verification** — Adversarial self-verification with tick-based scheduling. Priority: never-verified > challenged > stale > high-confidence. Opportunistic verification piggybacks on tool responses — no cron needed.

**Calibration** — Brier score by domain, systematic bias detection (overconfident vs underconfident), domain coverage gaps, actionable recommendations.

## Integration Example

```typescript
import { initDb, addBelief, addPrediction, getCalibration } from '@vokari/epistemic';

const db = initDb('./epistemic.db');

// Record a belief
addBelief(db, {
  statement: "User prefers concise responses",
  category: "user",
  confidence: 0.8,
  evidence: ["Said 'keep it short' on Feb 10"]
});

// Make a prediction
addPrediction(db, {
  topic: "project-deadline",
  prediction: "Sprint will ship by Friday",
  confidence: 0.7,
  resolution_criteria: "All PRs merged by EOD Friday",
  check_date: "2026-04-18"
});

// Check calibration
const cal = getCalibration(db);
// { accuracy: 0.83, brier_score: 0.15, total: 29, ... }
```

## MCP Tools Reference (35 tools)

### Beliefs (8)
| Tool | Description |
|------|-------------|
| `add_belief` | Record a belief with confidence, category, source, evidence |
| `list_beliefs` | List beliefs filtered by category/status/tags |
| `check_observation` | Check observation against existing beliefs for contradictions |
| `contradict_belief` | Record a contradiction against a belief |
| `confirm_belief` | Confirm a belief with optional evidence |
| `revise_belief` | Revise a belief statement |
| `belief_context` | Get formatted beliefs for system prompt injection |
| `belief_stats` | Get belief store statistics |

### Predictions (5)
| Tool | Description |
|------|-------------|
| `predict` | Make a prediction with confidence and check date |
| `revise_prediction` | Update prediction in-place with revision history |
| `resolve_prediction` | Resolve as correct/incorrect/partial/voided |
| `pending_predictions` | Get predictions due for review |
| `calibration` | Full calibration report with Brier scores and bias analysis |

### Positions (5)
| Tool | Description |
|------|-------------|
| `add_position` | Record an epistemic position on a topic |
| `challenge_position` | Challenge a position with counterevidence |
| `revise_position` | Revise position stance |
| `position_context` | Get formatted positions for system prompt |
| `unchallenged_positions` | Find stale positions not reviewed in N days |

### Corrections (6)
| Tool | Description |
|------|-------------|
| `correct` | Record a behavioral correction with category |
| `list_corrections` | List corrections filtered by type/status |
| `search_corrections` | Search corrections by keyword |
| `record_violation` | Track when a correction is violated (resets streak) |
| `graduate_correction` | Retire a correction after sustained compliance |
| `correction_stats` | Correction statistics by category |

### Verification (5)
| Tool | Description |
|------|-------------|
| `verification_tick` | Get beliefs due for adversarial review (priority-scheduled) |
| `create_verification` | Manually queue a belief for review |
| `record_verification` | Record result of adversarial review |
| `skip_verification` | Skip a verification with reason |
| `verification_status` | Verification coverage and timing stats |

### Context & Digest (2)
| Tool | Description |
|------|-------------|
| `assemble_context` | Budget-aware epistemic context for system prompt |
| `compile_digest` | Epistemic changelog since a given date |

### Knowledge Store (4)
| Tool | Description |
|------|-------------|
| `upsert_knowledge` | Add or update a knowledge entry |
| `get_knowledge` | Retrieve by type and key |
| `search_knowledge` | FTS5 search across all knowledge |
| `knowledge_stats` | Store statistics |

## Comparison vs. eval / observability tools

This is the closer competitive set — these are the things Vokari is adjacent to.

| Axis | Phoenix | LangSmith | Inspect AI | **Vokari** |
|---|---|---|---|---|
| When it runs | After a run | After a run | Batch eval | **Continuous, live** |
| What it sees | Traces | Traces | Prompts + responses | **Agent's own belief state** |
| Storage model | Postgres/Arize cloud | LangChain cloud | Files/JSON | **Local SQLite** |
| Persistence | Retention policy | Retention policy | Ad-hoc | **Owned by your agent** |
| MCP-native | No | No | No | **Yes** |
| Brier calibration | Via custom eval | Via custom eval | Via scorer | **First-class** |
| Corrections w/ streaks | No | No | No | **Yes** |
| Adversarial self-verification | No | No | No | **Yes** |
| Runs offline | Depends | No (cloud) | Yes | **Yes** |
| LLM calls from the tool | Optional | Optional | Optional | **No (deterministic)** |

## Comparison vs. memory retrieval tools

This is the *complementary* set — use Vokari WITH one of these, not INSTEAD OF.

| Axis | Mem0 | Zep/Graphiti | Letta | **Vokari** |
|---|---|---|---|---|
| Primary job | Remember what users said | Graph memory + temporal search | Stateful agent runtime | **Track agent's epistemic commitments** |
| Retrieval | Embeddings | Embeddings + graph | Embeddings | **FTS5 keyword only** |
| Deploys | Cloud / self-host | Cloud / self-host | Cloud / self-host | **Local binary, SQLite file** |
| External deps | ~40 | Postgres + embeddings | Postgres + embeddings | **3** |

Use Mem0/Zep/Letta for memory retrieval. Use Vokari for whether the memory (or the agent's inferences from it) are right.

## CLI

```bash
vokari init [--db ./epistemic.db]           # Initialize database
vokari serve [--dashboard] [--port 3838]    # Start MCP server (+ dashboard)
vokari dashboard [--port 3838]              # Dashboard only
vokari stats [--db ./epistemic.db]          # Print statistics
vokari context [--budget 5000]              # Print formatted context
vokari calibration                          # Print calibration report
vokari beliefs                              # Print belief statistics
vokari predictions                          # List pending predictions
vokari verify                               # Print verification status
vokari export [--out backup.json]           # Export all data as JSON
vokari import <file>                        # Import corrections.md or JSON backup
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `EPISTEMIC_DB` | `./epistemic.db` | SQLite database path |

## What Vokari is deliberately NOT

Explicit non-goals. Proposals that fit these categories are closed without discussion:

- **Vector / embedding search.** FTS5 is the only search. Bring your own retrieval if you want semantic matching — Vokari's job is the epistemic ledger, not the memory index.
- **LLM calls from inside Vokari.** The agent does reasoning; Vokari records what it committed to. Keeps behaviour deterministic and auditable.
- **Multi-tenancy / RBAC in open-source.** Single-process, single-user. Team use cases belong in a (future) hosted tier.
- **Autonomous truth oracle.** Vokari doesn't prove a belief is *correct*. It records that the agent asserted the belief at a given confidence, whether it was confirmed or contradicted later, and whether confidence tracked outcomes. Truth is the agent's problem; Vokari is the black box.
- **Replacement for tracing / eval platforms.** Phoenix, LangSmith, Inspect AI, Arize are complementary. Vokari doesn't ingest traces or datasets — it records the agent's own claims in flight.

## Failure-mode contract

Vokari is strict about *knowing what it doesn't know*. Every query that can produce an ambiguous answer does so explicitly:

| Condition | How Vokari reports it |
|---|---|
| Calibration with < 5 resolved predictions | `direction: 'well-calibrated', magnitude: 0, details: 'Insufficient data (N predictions)…'` |
| No predictions in a domain | Domain absent from `by_domain` array |
| Verification tick with nothing due | Empty `items[]`, `total_pending: 0` |
| Concurrent `createVerification` on same belief | Returns existing verification ID, no second row (enforced by partial unique index) |
| Migration partially applied | `runMigration` wraps SQL + `_migrations` record in one transaction — atomic |
| Malformed JSON in stored evidence | `safeJsonParse` returns `[]` fallback, no process crash |

Planned for v1.0:
- Result shapes include explicit `status: 'ok' | 'insufficient-data' | 'degraded'` fields where applicable.
- MCP tool responses surface the same statuses so agents can branch on them.

## Requirements

- Node.js >= 18
- `better-sqlite3` (native module, prebuilt binaries for common platforms)

## Development

```bash
npm ci
npm run build
npm test          # full suite, includes MCP protocol integration tests
```

CI runs the matrix on Node 18/20/22 × ubuntu/macos.

## License

MIT
