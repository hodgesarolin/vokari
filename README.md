# Vokari

Epistemic integrity engine for AI agents. Track what your agent believes, verify it's correct, measure calibration over time.

> Memory systems remember. Vokari verifies.

## 30-Second Quickstart

```bash
npx vokari init
npx vokari serve --dashboard
# Open http://localhost:3838
```

Add to your MCP client config (Claude Code, Cursor, etc.):

```json
{
  "mcpServers": {
    "vokari": {
      "command": "npx",
      "args": ["@vokari/epistemic"],
      "env": {
        "EPISTEMIC_DB": "./epistemic.db"
      }
    }
  }
}
```

## Why Vokari

The agent memory space is crowded — Mem0, Zep, Letta, YantrikDB all solve memory retrieval. None of them solve epistemic integrity: is what the agent believes actually *correct*, and is it getting more accurate over time?

Vokari tracks predictions with Brier score calibration, adversarially self-verifies beliefs on a scheduled tick, models epistemic positions with revision history, and provides calibration dashboards showing where an agent is systematically overconfident. No other tool does this.

**Mem0 remembers what users said. Vokari tracks whether the agent's knowledge is right.**

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

## Comparison

| Feature | Vokari | Mem0 | Zep/Graphiti | YantrikDB |
|---------|--------|------|--------------|-----------|
| Memory storage | SQLite | Cloud/Redis | PostgreSQL | MongoDB |
| Full-text search | FTS5 | Embedding | Embedding | Embedding |
| Beliefs with confidence | **Yes** | No | No | No |
| Predictions + calibration | **Yes** | No | No | No |
| Self-correction tracking | **Yes** | No | No | No |
| Adversarial verification | **Yes** | No | No | No |
| Brier score calibration | **Yes** | No | No | No |
| Position tracking | **Yes** | No | No | No |
| Calibration dashboard | **Yes** | No | No | No |
| Vector/embedding search | No | Yes | Yes | Yes |
| Entity graph | No | No | Yes | No |
| External dependencies | SQLite only | Cloud | PostgreSQL | MongoDB |

Vokari complements these tools — use Mem0 or Zep for memory retrieval, Vokari for epistemic integrity.

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

## Requirements

- Node.js >= 18
- better-sqlite3 (compiled native module)

## License

MIT
