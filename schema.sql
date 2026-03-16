-- Branching Conversation Tree Schema
-- Two tables only. The pointer chain IS the model.
-- Do not add tables without a correctness reason.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- threads: a named path through the turn graph.
-- A thread is identified by its root turn (fork_turn_id).
-- For the initial thread, fork_turn_id is NULL.
-- For a branched thread, fork_turn_id points to the turn where the fork occurred.
CREATE TABLE IF NOT EXISTS threads (
  id          TEXT PRIMARY KEY,           -- UUID
  label       TEXT NOT NULL,              -- human-readable name, e.g. "main", "Path A"
  fork_turn_id TEXT REFERENCES turns(id), -- NULL for root thread; pointer to fork point
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- turns: a single message node in the tree.
-- parent_turn_id is the entire pointer model.
-- Walking parent_turn_id to NULL gives you the full ancestry of any turn.
-- thread_id groups turns into a browsable branch, but ancestry crosses thread boundaries.
CREATE TABLE IF NOT EXISTS turns (
  id            TEXT PRIMARY KEY,                          -- UUID
  thread_id     TEXT NOT NULL REFERENCES threads(id),
  parent_turn_id TEXT REFERENCES turns(id),               -- NULL only for the first turn in root thread
  role          TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content       TEXT NOT NULL,
  depth         INTEGER NOT NULL DEFAULT 0,               -- distance from root; enforced <= 10 in app layer
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Index the pointer chain walk: assembleContext() walks parent_turn_id repeatedly.
-- Without this index, each step in the walk is a full table scan.
CREATE INDEX IF NOT EXISTS idx_turns_parent ON turns(parent_turn_id);

-- Index thread membership: GET /threads/[id] lists all turns in a thread.
CREATE INDEX IF NOT EXISTS idx_turns_thread ON turns(thread_id);

-- Index fork lookup: finding all threads forked from a given turn.
CREATE INDEX IF NOT EXISTS idx_threads_fork_turn ON threads(fork_turn_id);
