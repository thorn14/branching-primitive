/**
 * POST /api/fork
 *
 * Create a new thread branching from an existing turn.
 * No data is copied — the new thread shares ancestry via the pointer chain.
 *
 * User-initiated forks are not subject to the model's frequency throttle.
 * That rule only governs how often the model *suggests* a fork unprompted.
 *
 * Request body:
 *   {
 *     turnId: string,   // the turn to fork from
 *     label: string,    // human-readable label for the new branch (e.g. "Path A")
 *   }
 *
 * Response:
 *   {
 *     threadId: string,
 *     label: string,
 *     forkTurnId: string,
 *   }
 */

import { NextRequest } from 'next/server';
import { forkThread, getTurn } from '@/lib/canvas';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { turnId, label } = body as { turnId: string; label: string };

  if (!turnId || !label) {
    return new Response(JSON.stringify({ error: 'turnId and label are required' }), {
      status: 400,
    });
  }

  const turn = getTurn(turnId);
  if (!turn) {
    return new Response(JSON.stringify({ error: `Turn not found: ${turnId}` }), {
      status: 404,
    });
  }

  const result = forkThread({ forkTurnId: turnId, label });

  return new Response(JSON.stringify(result), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
}
