# Setup — Branching Conversation Primitive

## Prerequisites

- Node.js 18+
- A Baseten account with a model deployed (or any OpenAI-compatible endpoint)

## 1. Install dependencies

```bash
npm install
```

Key packages:

| Package | Purpose |
|---|---|
| `better-sqlite3` | SQLite driver (synchronous, runs in Next.js API routes) |
| `ai` | Vercel AI SDK (`streamText`, `generateText`, `CoreMessage`) |
| `@ai-sdk/openai` | OpenAI-compatible provider adapter (used for Baseten) |

## 2. Configure environment

Create `.env.local` in the project root:

```bash
# Baseten endpoint (OpenAI-compatible)
BASETEN_BASE_URL=https://bridge.baseten.co/v1/direct
BASETEN_API_KEY=your_baseten_api_key_here

# Model ID as deployed on Baseten
MODEL_ID=claude-sonnet-4-6

# Optional: custom SQLite path (default: ./canvas.db)
DB_PATH=./canvas.db
```

## 3. Initialize the database

The schema is applied automatically on first request via `getDb()` in `lib/canvas.ts`. No manual migration step is needed.

To inspect the schema directly:

```bash
sqlite3 canvas.db < schema.sql
sqlite3 canvas.db ".schema"
```

## 4. Start the dev server

```bash
npm run dev
```

Server runs on `http://localhost:3000`.

---

## API walkthrough — first fork/commit cycle

All examples use `curl`. Replace UUIDs with values returned from previous calls.

### Step 1: Create a root thread

```bash
# There is no POST /threads endpoint in v1 — create the first thread
# by sending an initial chat message without a parentTurnId.
# You must create the thread directly via the DB or add a /threads POST route.
# For the prototype, seed via sqlite3:

sqlite3 canvas.db "INSERT INTO threads (id, label) VALUES ('thread-main-001', 'main');"
```

### Step 2: Send the first message

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "threadId": "thread-main-001",
    "content": "I need to decide between a microservices architecture and a monolith for our new product. What should I consider?"
  }'
```

The response is a Vercel AI SDK data stream. The assistant will reply with analysis. If it detects a genuine fork opportunity, it will append:

```
FORK OPPORTUNITY
Path A — Explore microservices: containerization, service mesh, operational overhead
Path B — Explore monolith-first: faster iteration, lower ops cost, refactor later
```

### Step 3: Get the thread to find turn IDs

```bash
curl http://localhost:3000/api/threads/thread-main-001
```

Response:
```json
{
  "thread": { "id": "thread-main-001", "label": "main", "fork_turn_id": null },
  "turns": [
    { "id": "turn-001", "role": "user", "content": "...", "depth": 0 },
    { "id": "turn-002", "role": "assistant", "content": "...", "depth": 1 }
  ],
  "ancestry": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ]
}
```

### Step 4: Fork at the assistant's turn

User-initiated fork from `turn-002` (the fork point):

```bash
curl -X POST http://localhost:3000/api/fork \
  -H "Content-Type: application/json" \
  -d '{
    "turnId": "turn-002",
    "label": "Path A — microservices"
  }'
```

Response:
```json
{
  "threadId": "thread-branch-a-xyz",
  "label": "Path A — microservices",
  "forkTurnId": "turn-002"
}
```

Repeat for Path B:

```bash
curl -X POST http://localhost:3000/api/fork \
  -H "Content-Type: application/json" \
  -d '{
    "turnId": "turn-002",
    "label": "Path B — monolith"
  }'
```

### Step 5: Continue each branch independently

```bash
# Branch A
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "threadId": "thread-branch-a-xyz",
    "content": "Walk me through the service mesh options for a team of 5 engineers."
  }'

# Branch B
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "threadId": "thread-branch-b-xyz",
    "content": "What does the refactor path look like when we outgrow the monolith?"
  }'
```

Each branch assembles context by walking the pointer chain through the shared ancestry (`turn-001`, `turn-002`) and then the branch-specific turns. The model sees the full history.

### Step 6: Commit and synthesize

When both branches have been explored:

```bash
curl -X POST http://localhost:3000/api/commit \
  -H "Content-Type: application/json" \
  -d '{
    "threadId": "thread-branch-a-xyz",
    "siblingThreadIds": ["thread-branch-b-xyz"]
  }'
```

Response:
```json
{
  "committed": true,
  "synthesis": "## Branch: Path A — microservices\n\n...\n\n## Branch: Path B — monolith\n\n...\n\n## Recommendation\n\n..."
}
```

---

## Verifying pointer chain correctness

```bash
# Inspect full pointer chain for a turn
sqlite3 canvas.db "
  WITH RECURSIVE chain(id, parent_turn_id, role, depth) AS (
    SELECT id, parent_turn_id, role, depth FROM turns WHERE id = 'YOUR_TURN_ID'
    UNION ALL
    SELECT t.id, t.parent_turn_id, t.role, t.depth
    FROM turns t JOIN chain c ON t.id = c.parent_turn_id
  )
  SELECT * FROM chain ORDER BY depth ASC;
"
```

---

## Next steps

### 1. Replace string-match fork detection with `suggest_fork` tool call

The current `detectFork()` in `lib/canvas.ts` matches `FORK OPPORTUNITY` as a string. This is fragile. The correct approach:

Define a `suggest_fork` tool in the `streamText` call:

```typescript
tools: {
  suggest_fork: {
    description: 'Suggest forking the conversation into two parallel paths',
    parameters: z.object({
      pathA: z.string().describe('Description of path A'),
      pathB: z.string().describe('Description of path B'),
      rationale: z.string().describe('Why these paths diverge'),
    }),
  },
}
```

Handle `toolCall` events from the stream to surface fork suggestions in real-time, before the response finishes. This eliminates the string-matching step entirely and gives you typed fork metadata.

### 2. Summarization fallback for deep trees

The `MAX_DEPTH = 10` cap in `lib/canvas.ts` prevents context window overflow but is a blunt instrument. The right solution:

- When `assembleContext()` detects depth approaching the model's context limit, summarize the oldest N turns into a single `[Summary: ...]` turn before assembling.
- Store summaries as synthetic turns with `role: 'system'` and a special marker.
- Reference counting (see below) helps identify which turns are safe to summarize vs. which are shared fork points that must be preserved verbatim.

### 3. Reference counting for branch garbage collection

Currently, turns are never deleted. In a long-running system with many forks, orphaned branches accumulate. A reference count on turns would enable:

- Detecting when a turn has no downstream branches (ref count drops to 0)
- Safely garbage-collecting unreachable turns
- Preventing GC of turns that are active fork points

Implementation: add a `ref_count INTEGER DEFAULT 1` column to `turns`. Increment on fork, decrement on branch deletion. Delete when `ref_count = 0` and the turn has no active thread.

This interacts with the ancestry mutation constraint: a turn with `ref_count > 1` is shared and cannot be edited or deleted.
