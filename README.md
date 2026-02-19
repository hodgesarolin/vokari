# @vokari/epistemic

Self-verification engine for AI assistants. Stores corrections, tracks violations, and injects them into system prompts via MCP.

**The problem:** LLMs can't self-correct without external ground truth ([Zhang et al., ACL 2025](https://arxiv.org/abs/2310.01798)). When a user says "no, it's PS 28, not PS 27" — that correction needs to persist, get injected into every future conversation, and eventually be retired when the root cause is fixed.

**What this does:**
- Stores corrections with type, permanence, and DPO training pairs
- Injects active corrections into system prompts, priority-ordered within a character budget
- Tracks violations and streaks
- Graduates corrections when they're no longer needed
- Exposes everything via MCP tools

## Install

```bash
npm install @vokari/epistemic
```

## Quick Start

### As an MCP server

```bash
EPISTEMIC_DB=./my-corrections.db npx @vokari/epistemic
```

Add to Claude Desktop or any MCP client:

```json
{
  "mcpServers": {
    "epistemic": {
      "command": "npx",
      "args": ["@vokari/epistemic"],
      "env": {
        "EPISTEMIC_DB": "/path/to/epistemic.db"
      }
    }
  }
}
```

### Import existing corrections

If you have corrections in markdown format:

```bash
npx @vokari/epistemic import corrections.md --db ./epistemic.db
```

### As a library

```typescript
import { initDb, addCorrection, getContext } from '@vokari/epistemic';

const db = initDb('./epistemic.db');

addCorrection(db, {
  type: 'fact',
  content: "User's school is PS 28, NOT PS 27",
  root_cause: 'Hallucinated school number',
  example_bad: 'Your child attends PS 27',
  example_good: 'Your child attends PS 28 (Christa McAuliffe)',
  permanence: 'never', // personal fact — model can't learn this
});

// Get formatted corrections for system prompt injection
const context = getContext(db, 4000); // 4000 char budget
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `correct` | Store a new correction |
| `get_context` | Get formatted corrections for system prompt injection |
| `list_corrections` | List corrections, optionally filtered by type |
| `record_violation` | Record that a correction was violated |
| `graduate_correction` | Retire a correction that's no longer needed |
| `delete_correction` | Permanently remove a correction |
| `stats` | Get correction store statistics |

## CLI

```bash
epistemic import <file.md>          # Import corrections from markdown
epistemic context [--budget 4000]   # Print context block
epistemic stats                     # Print store statistics
```

## Correction Types

| Type | What it means | Example |
|------|--------------|---------|
| `policy` | Scope boundary — never graduate | "Don't discuss work topics" |
| `fact` | Wrong data | "Income is $105/hr, not $96" |
| `pattern` | Wrong behavior | "Check dates before stating them" |
| `technical` | Implementation issue | "Use file append, not overwrite" |

## Permanence Levels

| Level | When to graduate | Example |
|-------|-----------------|---------|
| `never` | Never — permanent runtime patch | Personal facts, scope policies |
| `conditional` | When verified in source of truth | Public facts that may enter training data |
| `graduable` | After 90 days + zero recurrences | Behavioral patterns |

## DPO Training Pairs

Every correction with `example_bad` and `example_good` is a DPO training pair. Export them for fine-tuning:

```typescript
const corrections = listCorrections(db, { active: true });
const pairs = corrections
  .filter(c => c.example_bad && c.example_good)
  .map(c => ({
    rejected: c.example_bad,
    chosen: c.example_good,
    context: c.content,
  }));
```

## License

MIT
