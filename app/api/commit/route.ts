/**
 * POST /api/commit
 *
 * Mark a branch as complete and optionally trigger cross-branch synthesis.
 *
 * "Commit" here means: this branch is done exploring its path. The caller
 * may provide sibling thread IDs for synthesis — the endpoint assembles
 * the full context of each branch and asks the model to compare them.
 *
 * Request body:
 *   {
 *     threadId: string,           // the branch being committed
 *     siblingThreadIds?: string[] // other branches to synthesize against
 *   }
 *
 * Response (non-streaming):
 *   {
 *     committed: true,
 *     synthesis?: string  // synthesis text if siblingThreadIds were provided
 *   }
 *
 * Known hard problem: cross-branch synthesis UX.
 * Assembling full context for N branches compounds context window usage.
 * For v1, synthesis is a single non-streamed call. This will hit token limits
 * on deep trees with multiple branches. Summarization fallback is a v2 concern.
 */

import { NextRequest } from 'next/server';
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  getThread,
  getLatestTurnInThread,
  assembleContext,
} from '@/lib/canvas';

const baseten = createOpenAI({
  baseURL: process.env.BASETEN_BASE_URL ?? 'https://bridge.baseten.co/v1/direct',
  apiKey: process.env.BASETEN_API_KEY ?? '',
});

const MODEL = process.env.MODEL_ID ?? 'claude-sonnet-4-6';

const SYSTEM_PROMPT = readFileSync(
  join(process.cwd(), 'canvas-system-prompt.md'),
  'utf-8'
);

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { threadId, siblingThreadIds } = body as {
    threadId: string;
    siblingThreadIds?: string[];
  };

  if (!threadId) {
    return new Response(JSON.stringify({ error: 'threadId is required' }), {
      status: 400,
    });
  }

  const thread = getThread(threadId);
  if (!thread) {
    return new Response(JSON.stringify({ error: `Thread not found: ${threadId}` }), {
      status: 404,
    });
  }

  // No sibling threads: just acknowledge the commit.
  if (!siblingThreadIds || siblingThreadIds.length === 0) {
    return new Response(JSON.stringify({ committed: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Validate sibling threads exist.
  const allThreadIds = [threadId, ...siblingThreadIds];
  const branches: { label: string; context: ReturnType<typeof assembleContext> }[] = [];

  for (const tid of allThreadIds) {
    const t = getThread(tid);
    if (!t) {
      return new Response(JSON.stringify({ error: `Thread not found: ${tid}` }), {
        status: 404,
      });
    }
    const latestTurn = getLatestTurnInThread(tid);
    if (!latestTurn) {
      // Empty thread — skip rather than error.
      continue;
    }
    branches.push({ label: t.label, context: assembleContext(latestTurn.id) });
  }

  if (branches.length < 2) {
    return new Response(
      JSON.stringify({ committed: true, synthesis: null, note: 'Not enough non-empty branches to synthesize' }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Build synthesis prompt.
  // Inject each branch's full conversation as a labeled block.
  // Hard problem: this scales linearly with branch depth * branch count.
  const branchBlocks = branches
    .map(({ label, context }) => {
      const formatted = context
        .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
        .join('\n\n');
      return `## Branch: ${label}\n\n${formatted}`;
    })
    .join('\n\n---\n\n');

  const synthesisRequest =
    `You are synthesizing the following branches of a branching conversation. ` +
    `Produce a structured comparison per your system instructions.\n\n` +
    branchBlocks;

  const { text: synthesis } = await generateText({
    model: baseten(MODEL),
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: synthesisRequest }],
  });

  return new Response(JSON.stringify({ committed: true, synthesis }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
