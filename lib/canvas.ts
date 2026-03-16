/**
 * lib/canvas.ts — Core branching conversation logic.
 *
 * The pointer chain is the entire model. Every function here either:
 *   (a) walks parent_turn_id to assemble ancestry, or
 *   (b) inserts new nodes without mutating existing ones.
 *
 * Hard constraints enforced here:
 *   - Tree depth cap: MAX_DEPTH = 10
 *   - No ancestry mutation: shared turns are read-only
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { CoreMessage } from 'ai';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Thread {
  id: string;
  label: string;
  fork_turn_id: string | null;
  created_at: number;
}

export interface Turn {
  id: string;
  thread_id: string;
  parent_turn_id: string | null;
  role: 'user' | 'assistant';
  content: string;
  depth: number;
  created_at: number;
}

export interface ForkDetection {
  detected: boolean;
  pathA?: string;
  pathB?: string;
}

export interface ForkResult {
  threadId: string;
  label: string;
  forkTurnId: string;
}

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

const MAX_DEPTH = 10;

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const dbPath = process.env.DB_PATH ?? join(process.cwd(), 'canvas.db');
  _db = new Database(dbPath);

  // Apply schema on first connection
  const schema = readFileSync(join(process.cwd(), 'schema.sql'), 'utf-8');
  _db.exec(schema);

  return _db;
}

// ---------------------------------------------------------------------------
// assembleContext — THE critical function.
//
// Walk parent_turn_id from `turnId` to the root, collecting turns.
// Reverse the collected list to chronological order.
// Return as a CoreMessage array for the Vercel AI SDK.
//
// This walks across thread boundaries intentionally: shared ancestry before
// a fork point belongs to a different thread_id, but the pointer chain is
// the ground truth — not the thread_id column.
//
// Bugs will surface here. Test against:
//   - Deep trees (depth approaching MAX_DEPTH)
//   - Cross-branch queries (turn_id from branch B, ancestry through branch A)
//   - Turns with no parent (root turn)
//   - Invalid turn IDs (should throw, not silently return empty)
// ---------------------------------------------------------------------------

export function assembleContext(turnId: string): CoreMessage[] {
  const db = getDb();
  const stmt = db.prepare<[string], Turn>(
    'SELECT * FROM turns WHERE id = ?'
  );

  const turns: Turn[] = [];
  let current: Turn | undefined = stmt.get(turnId);

  if (!current) {
    throw new Error(`assembleContext: turn not found: ${turnId}`);
  }

  // Walk the pointer chain. Guard against cycles (shouldn't exist, but be safe).
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current.id)) {
      throw new Error(`assembleContext: cycle detected at turn ${current.id}`);
    }
    visited.add(current.id);
    turns.push(current);

    if (!current.parent_turn_id) break;
    current = stmt.get(current.parent_turn_id);
  }

  // turns is root-to-leaf reversed; reverse to get chronological order.
  turns.reverse();

  return turns.map((t) => ({
    role: t.role,
    content: t.content,
  }));
}

// ---------------------------------------------------------------------------
// Thread operations
// ---------------------------------------------------------------------------

export function createRootThread(label = 'main'): Thread {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    'INSERT INTO threads (id, label, fork_turn_id) VALUES (?, ?, NULL)'
  ).run(id, label);

  return db.prepare<[string], Thread>('SELECT * FROM threads WHERE id = ?').get(id)!;
}

export function getThread(threadId: string): Thread | undefined {
  return getDb()
    .prepare<[string], Thread>('SELECT * FROM threads WHERE id = ?')
    .get(threadId);
}

export function listThreads(): Thread[] {
  return getDb()
    .prepare<[], Thread>('SELECT * FROM threads ORDER BY created_at ASC')
    .all();
}

// ---------------------------------------------------------------------------
// Turn operations
// ---------------------------------------------------------------------------

export function addTurn(params: {
  threadId: string;
  parentTurnId: string | null;
  role: 'user' | 'assistant';
  content: string;
}): Turn {
  const db = getDb();
  const id = randomUUID();

  // Compute depth from parent. Enforce MAX_DEPTH.
  let depth = 0;
  if (params.parentTurnId) {
    const parent = db
      .prepare<[string], Pick<Turn, 'depth'>>('SELECT depth FROM turns WHERE id = ?')
      .get(params.parentTurnId);
    if (!parent) {
      throw new Error(`addTurn: parent turn not found: ${params.parentTurnId}`);
    }
    depth = parent.depth + 1;
    if (depth > MAX_DEPTH) {
      throw new Error(
        `addTurn: depth limit reached (${MAX_DEPTH}). ` +
        `Cannot add turn at depth ${depth}. Start a new thread or summarize.`
      );
    }
  }

  db.prepare(
    'INSERT INTO turns (id, thread_id, parent_turn_id, role, content, depth) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, params.threadId, params.parentTurnId ?? null, params.role, params.content, depth);

  return db.prepare<[string], Turn>('SELECT * FROM turns WHERE id = ?').get(id)!;
}

export function getTurn(turnId: string): Turn | undefined {
  return getDb()
    .prepare<[string], Turn>('SELECT * FROM turns WHERE id = ?')
    .get(turnId);
}

export function getThreadTurns(threadId: string): Turn[] {
  // Returns all turns with thread_id = threadId in insertion order.
  // Note: this does NOT include shared ancestry turns from parent threads.
  // Use assembleContext() on the leaf turn to get the full ancestry.
  return getDb()
    .prepare<[string], Turn>(
      'SELECT * FROM turns WHERE thread_id = ? ORDER BY depth ASC, created_at ASC'
    )
    .all(threadId);
}

export function getLatestTurnInThread(threadId: string): Turn | undefined {
  // Returns the most recently added turn in a thread.
  return getDb()
    .prepare<[string], Turn>(
      'SELECT * FROM turns WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1'
    )
    .get(threadId);
}

// ---------------------------------------------------------------------------
// Fork operations
// ---------------------------------------------------------------------------

// forkThread: create a new thread branching from an existing turn.
// The new thread shares all ancestry of forkTurnId — no data is copied.
// The first message sent to the new thread will have parent_turn_id = forkTurnId.
export function forkThread(params: {
  forkTurnId: string;
  label: string;
}): ForkResult {
  const db = getDb();

  const forkTurn = getTurn(params.forkTurnId);
  if (!forkTurn) {
    throw new Error(`forkThread: fork turn not found: ${params.forkTurnId}`);
  }

  const threadId = randomUUID();
  db.prepare(
    'INSERT INTO threads (id, label, fork_turn_id) VALUES (?, ?, ?)'
  ).run(threadId, params.label, params.forkTurnId);

  return { threadId, label: params.label, forkTurnId: params.forkTurnId };
}

// ---------------------------------------------------------------------------
// Fork detection (v1: fragile string matching)
//
// TODO: replace with suggest_fork tool call.
// The correct approach is a structured tool call where the model returns
// a `suggest_fork` function call with typed pathA/pathB descriptions.
// String matching on "FORK OPPORTUNITY" is brittle: it breaks on whitespace
// variation, localization, or any prompt that discusses forking as a concept.
// ---------------------------------------------------------------------------

export function detectFork(assistantResponse: string): ForkDetection {
  if (!assistantResponse.includes('FORK OPPORTUNITY')) {
    return { detected: false };
  }

  // Parse "Path A — <description>" and "Path B — <description>"
  // Using em dash (—) as separator per system prompt spec.
  const pathAMatch = assistantResponse.match(/Path A\s*[—–-]+\s*(.+)/);
  const pathBMatch = assistantResponse.match(/Path B\s*[—–-]+\s*(.+)/);

  if (!pathAMatch || !pathBMatch) {
    // The model included FORK OPPORTUNITY but didn't format paths correctly.
    // Return detected: false rather than crashing — the UI can ignore it.
    console.warn('detectFork: FORK OPPORTUNITY found but paths malformed');
    return { detected: false };
  }

  return {
    detected: true,
    pathA: pathAMatch[1].trim(),
    pathB: pathBMatch[1].trim(),
  };
}

// ---------------------------------------------------------------------------
// Branch context header
// Injected as the first user message when a forked thread receives a message.
// ---------------------------------------------------------------------------

export function buildBranchContextHeader(params: {
  parentTurnId: string;
  parentThreadId: string;
  pathLabel: string;
}): string {
  return (
    `[Branch context: forked from turn ${params.parentTurnId} on thread ${params.parentThreadId}]\n` +
    `[Path taken: ${params.pathLabel}]`
  );
}
