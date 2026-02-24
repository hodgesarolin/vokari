# @vokari/epistemic

An epistemic engine for AI assistants. Track what your AI believes, predict outcomes, catch mistakes, and build calibrated confidence — all via MCP.

> Mem0 remembers what you said. Vokari tracks what it *believes* — and knows when it's wrong.

## The Problem

LLMs forget everything between sessions. Current solutions (Mem0, server-memory) add persistence — but persistence without self-correction just means your AI remembers its mistakes forever.

What's actually missing:
- **No self-correction.** When a user says "that's wrong," the correction needs to persist, get injected into every future session, and eventually retire when the root cause is fixed.
- **No uncertainty tracking.** Your AI should know what it's confident about and what it's guessing at — and get better at knowing the difference over time.
- **No calibration.** If your AI says "I'm 80% sure," it should actually be right ~80% of the time. Without tracking, you can't tell.

## What This Does

Vokari gives AI assistants an epistemic layer — beliefs, predictions, corrections, positions, and calibration — stored in SQLite, served via MCP, with built-in adversarial self-verification.

**45 tools. 607 tests. Zero external dependencies beyond SQLite.**

Dogfooded for 500+ hours as [Brain](https://github.com/hodgesarolin/brain), a personal AI assistant running on Claude Opus.

## Quick Start

### As an MCP Server (Claude Desktop, Cursor, etc.)

```bash
npx @vokari/epistemic
```

Add to your MCP client config:

```json
{
  "mcpServers": {
    "epistemic": {
      "command": "npx",
      "args": ["@vokari/epistemic"],
      "env": {
        "EPISTEMIC_DB": "./epistemic.db"
      }
    }
  }
}
```

### As a Library

```typescript
import { initDb, addBelief, predict, calibration } from '@vokari/epistemic';

const db = initDb('./epistemic.db');

// Record a belief
addBelief(db, {
  statement: "User prefers concise responses",
  category: "user",
  confidence: 0.8,
  evidence: ["Said 'keep it short' on Feb 10"]
});

// Make a prediction
predict(db, {
  topic: "project-deadline",
  prediction: "Sprint will ship by Friday",
  confidence: 0.7,
  resolution_criteria: "All PRs merged by EOD Friday"
});

// Check calibration
const cal = calibration(db);
// → { accuracy: 0.83, brier: 0.15, predictions: 29, ... }
```

## Tools by Layer

Vokari organizes 45 tools into progressive layers. Start with what you need; add depth as you go.

### Layer 1: Corrections — "What did I get wrong?"

Store mistakes with DPO-ready training pairs. Inject active corrections into every system prompt.

| Tool | What it does |
|------|-------------|
| `correct` | Store a correction with type, root cause, and good/bad examples |
| `get_context` | Get formatted corrections for system prompt injection |
| `list_corrections` | List corrections, optionally filtered by type |
| `record_violation` | Track when a correction is violated again |
| `graduate_correction` | Retire a correction that's been fixed |
| `delete_correction` | Remove permanently |
| `correction_stats` | Overview statistics |

```
You: "correct" → type: "fact", content: "User's school is PS 28, NOT PS 27"
AI gets it right next time. And every time after.
```

### Layer 2: Beliefs — "What do I think is true?"

Record beliefs about the user, system, world, or itself. Check new observations against existing beliefs. Detect contradictions automatically.

| Tool | What it does |
|------|-------------|
| `add_belief` | Record a belief (user/system/world/self) |
| `list_beliefs` | Browse and filter beliefs |
| `check_observation` | Check new info against existing beliefs |
| `contradict_belief` | Record a contradiction |
| `confirm_belief` | Confirm with new evidence |
| `revise_belief` | Update a belief |
| `belief_context` | Format beliefs for system prompt |
| `belief_stats` | Statistics |

### Layer 3: Predictions — "What will happen?"

Make predictions with explicit confidence levels, resolution criteria, and check dates. Track outcomes. Get Brier-scored calibration reports.

| Tool | What it does |
|------|-------------|
| `predict` | Make a prediction with confidence + check date |
| `resolve_prediction` | Mark correct/incorrect/partial/voided |
| `pending_predictions` | Get predictions due for review |
| `calibration` | Full report: accuracy, Brier score, bias analysis |

```
You: "predict" → "PR will merge by Thursday" (70% confidence)
Thursday: "resolve_prediction" → correct
After 20+ predictions: "calibration" → Brier: 0.15, accuracy: 83%
→ Your AI learns whether its 70% actually means 70%.
```

### Layer 4: Positions — "What do I think about that?"

Record opinions with reasoning and confidence. Challenge stale positions. Track how thinking evolves.

| Tool | What it does |
|------|-------------|
| `add_position` | Record a position with reasoning |
| `challenge_position` | Increment challenge count |
| `revise_position` | Update with new stance + confidence |
| `position_context` | Format positions for system prompt |
| `unchallenged_positions` | Find stale positions (N days without challenge) |

### Layer 5: Self-Verification — "Am I still right?"

Adversarial review system. Automatically queues beliefs for challenge based on staleness, contradictions, or high confidence. Records review outcomes.

| Tool | What it does |
|------|-------------|
| `verification_tick` | Get beliefs due for adversarial review |
| `create_verification` | Manually queue a belief for review |
| `record_verification` | Record review results |
| `skip_verification` | Skip reviews that can't be completed |
| `verification_status` | Coverage and outcome statistics |

### Layer 6: Events & Awareness — "What's happening around me?"

Session event tracking and cross-session awareness.

| Tool | What it does |
|------|-------------|
| `log_event` | Log to session event stream |
| `awareness` | Get active sessions, recent completions |
| `event_stats` | Event stream statistics |

### Layer 7: Analysis — "Am I thinking clearly?"

Detect cognitive anti-patterns: repetitive loops, attention drift, noisy inputs.

| Tool | What it does |
|------|-------------|
| `analyze_conversation` | Extract beliefs, topics, corrections from messages |
| `check_cycling` | Detect repetitive thinking patterns |
| `check_attention` | Analyze attention budget vs. priority categories |
| `distill` | Extract signal from noise in log content |

### Layer 8: Knowledge Store — "Where does it all go?"

Unified storage with 12 content types, FTS5 full-text search, and a context compiler that builds prompt-ready context within a token budget.

| Tool | What it does |
|------|-------------|
| `upsert_knowledge` | Add/update entries (12 types: belief, correction, research, handoff, etc.) |
| `get_knowledge` | Retrieve by type + key |
| `search_knowledge` | Full-text search (BM25 ranking) |
| `list_knowledge` | Browse entries |
| `assemble_context` | **Compile a context window** — 3-layer architecture (mandatory → session → relevance) within a character budget |
| `knowledge_stats` | Store statistics |
| `import_to_knowledge` | Import from legacy stores |
| `upsert_handoff` | Write session handoff documents |
| `get_handoff` | Read session handoffs |

## How It Compares

| Feature | Vokari | Hindsight | Mem0 | server-memory |
|---------|--------|-----------|------|---------------|
| Memory storage | ✅ | ✅ (4 networks) | ✅ | ✅ |
| Full-text search | ✅ FTS5 | ✅ (multi-strategy) | ✅ | ✅ |
| Opinions/beliefs w/ confidence | ✅ | ✅ | ❌ | ❌ |
| Predictions + calibration | ✅ | ❌ | ❌ | ❌ |
| Self-correction persistence | ✅ | ❌ | ❌ | ❌ |
| Adversarial self-verification | ✅ | ❌ | ❌ | ❌ |
| Brier score calibration | ✅ | ❌ | ❌ | ❌ |
| Position tracking + challenge | ✅ | ❌ | ❌ | ❌ |
| Context compilation (budget-aware) | ✅ | ❌ | ❌ | ❌ |
| Disposition parameters | ❌ (v0.3) | ✅ | ❌ | ❌ |
| Entity graph retrieval | ❌ | ✅ | ❌ | ❌ |
| Standard benchmark results | ❌ | ✅ (91.4% LongMemEval) | ❌ | ❌ |
| External dependencies | SQLite only | PostgreSQL + Docker | Redis/cloud | SQLite |
| Tools/API surface | 45 MCP tools | REST API | ~6 tools | ~5 tools |
| Tests | 607 | — | — | — |

## Architecture

```
┌──────────────────────────────────────────┐
│              MCP Client                   │
│  (Claude Desktop, Cursor, custom agent)   │
└──────────────┬───────────────────────────┘
               │ MCP protocol
┌──────────────▼───────────────────────────┐
│         @vokari/epistemic                 │
│                                           │
│  ┌─────────┐ ┌──────────┐ ┌───────────┐ │
│  │Beliefs  │ │Predictions│ │Corrections│ │
│  └────┬────┘ └─────┬─────┘ └─────┬─────┘ │
│       │             │             │       │
│  ┌────▼─────────────▼─────────────▼────┐ │
│  │        Unified Knowledge Store       │ │
│  │    (SQLite + FTS5, 12 content types) │ │
│  └──────────────┬──────────────────────┘ │
│                 │                         │
│  ┌──────────────▼──────────────────────┐ │
│  │        Context Compiler              │ │
│  │  mandatory → session → relevance     │ │
│  │  (budget-aware, session-type-aware)  │ │
│  └─────────────────────────────────────┘ │
└──────────────────────────────────────────┘
```

## Correction Types

| Type | Graduates? | Example |
|------|-----------|---------|
| `policy` | Never | "Don't discuss work topics" |
| `fact` | When verified | "Income is $105/hr, not $96" |
| `pattern` | After 90 days + 0 recurrences | "Verify dates before stating them" |
| `technical` | When root cause fixed | "Use file append, not overwrite" |

Every correction with `example_bad` and `example_good` is a DPO training pair — export them for fine-tuning.

## Real-World Usage

Brain, a personal AI assistant, has used @vokari/epistemic for 500+ hours:
- 35 corrections (7 policy, 16 fact, 8 pattern, 4 technical)
- 25 active predictions tracked, 82.8% accuracy (Brier: 0.156)
- 30 positions with active challenge/revision cycles
- 224 knowledge entries with FTS5 search
- Adversarial verification running on a schedule

The epistemic layer catches errors that would otherwise persist forever: wrong facts, behavioral patterns, stale predictions. It's the difference between an AI that remembers and an AI that learns.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `EPISTEMIC_DB` | `./epistemic.db` | SQLite database path |

## Requirements

- Node.js >= 18
- better-sqlite3 (compiled native module)

## Contributing

Issues and PRs welcome at [github.com/hodgesarolin/vokari](https://github.com/hodgesarolin/vokari).

## License

MIT
