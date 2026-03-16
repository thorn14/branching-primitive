/**
 * GET /api/threads/[id]
 *
 * List all turns that belong directly to a thread, plus full assembled
 * ancestry starting from the thread's latest turn.
 *
 * Response:
 *   {
 *     thread: Thread,
 *     turns: Turn[],          // turns with thread_id == id, chronological
 *     ancestry: CoreMessage[] // full context from assembleContext(latestTurnId)
 *   }
 *
 * Note on ancestry vs turns:
 *   `turns` contains only the turns stored in this thread.
 *   `ancestry` walks the pointer chain across thread boundaries and includes
 *   all shared turns from parent threads. Use `ancestry` to reconstruct what
 *   the model sees; use `turns` to display what happened in this branch.
 */

import { NextRequest } from 'next/server';
import {
  getThread,
  getThreadTurns,
  assembleContext,
  getLatestTurnInThread,
} from '@/lib/canvas';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const thread = getThread(id);
  if (!thread) {
    return new Response(JSON.stringify({ error: `Thread not found: ${id}` }), {
      status: 404,
    });
  }

  const turns = getThreadTurns(id);
  const latestTurn = getLatestTurnInThread(id);

  // Ancestry is only available if the thread has at least one turn.
  const ancestry = latestTurn ? assembleContext(latestTurn.id) : [];

  return new Response(
    JSON.stringify({ thread, turns, ancestry }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}
