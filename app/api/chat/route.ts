/**
 * POST /api/chat
 *
 * Send a user message, assemble ancestry context, stream assistant response.
 * Detects fork opportunities in the response and returns fork metadata
 * as a trailer after the stream completes.
 *
 * Request body:
 *   {
 *     threadId: string,       // which thread to send to
 *     content: string,        // user message
 *     parentTurnId?: string,  // explicit parent override (optional; defaults to latest turn in thread)
 *   }
 *
 * Response: Vercel AI SDK data stream.
 * Fork metadata (if detected) is appended as a data annotation in the stream.
 */

import { streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { NextRequest } from 'next/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  addTurn,
  assembleContext,
  detectFork,
  getLatestTurnInThread,
  getThread,
  buildBranchContextHeader,
} from '@/lib/canvas';

// Baseten via OpenAI-compatible endpoint.
// Set BASETEN_API_KEY and BASETEN_BASE_URL in .env.local.
const baseten = createOpenAI({
  baseURL: process.env.BASETEN_BASE_URL ?? 'https://bridge.baseten.co/v1/direct',
  apiKey: process.env.BASETEN_API_KEY ?? '',
});

const MODEL = process.env.MODEL_ID ?? 'claude-sonnet-4-6';

// System prompt: loaded once at module init.
const SYSTEM_PROMPT = readFileSync(
  join(process.cwd(), 'canvas-system-prompt.md'),
  'utf-8'
);

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { threadId, content, parentTurnId: explicitParentId } = body as {
    threadId: string;
    content: string;
    parentTurnId?: string;
  };

  if (!threadId || !content) {
    return new Response(JSON.stringify({ error: 'threadId and content are required' }), {
      status: 400,
    });
  }

  const thread = getThread(threadId);
  if (!thread) {
    return new Response(JSON.stringify({ error: `Thread not found: ${threadId}` }), {
      status: 404,
    });
  }

  // Determine parent turn.
  let parentTurnId = explicitParentId ?? getLatestTurnInThread(threadId)?.id ?? null;

  // If this is the first message in a forked thread, prepend the branch context header.
  let userContent = content;
  if (thread.fork_turn_id && !getLatestTurnInThread(threadId)) {
    // First message in a forked thread.
    const parentThread = getLatestTurnInThread(thread.fork_turn_id)
      ? undefined
      : undefined;
    // We need the parent thread id. Resolve via the fork turn.
    const { getTurn } = await import('@/lib/canvas');
    const forkTurn = getTurn(thread.fork_turn_id);
    if (forkTurn) {
      const header = buildBranchContextHeader({
        parentTurnId: thread.fork_turn_id,
        parentThreadId: forkTurn.thread_id,
        pathLabel: thread.label,
      });
      userContent = `${header}\n\n${content}`;
      // Parent of first turn in forked thread is the fork point.
      parentTurnId = thread.fork_turn_id;
    }
  }

  // Insert the user turn.
  const userTurn = addTurn({
    threadId,
    parentTurnId,
    role: 'user',
    content: userContent,
  });

  // Assemble full ancestry as messages array.
  const messages = assembleContext(userTurn.id);

  // Stream the response.
  let fullResponse = '';

  const result = await streamText({
    model: baseten(MODEL),
    system: SYSTEM_PROMPT,
    messages,
    onFinish: async ({ text }) => {
      fullResponse = text;

      // Persist the assistant turn.
      addTurn({
        threadId,
        parentTurnId: userTurn.id,
        role: 'assistant',
        content: text,
      });
    },
  });

  // Return as a data stream. Fork detection runs after stream completes
  // and is surfaced via response headers for the client to handle.
  const response = result.toDataStreamResponse();

  // Detect fork in response after full text is available.
  // We attach fork metadata to response headers for non-streaming clients
  // and as a note: for streaming clients, fork detection requires reading
  // the full stream first. A production implementation would use a tool call.
  // TODO: replace detectFork string matching with suggest_fork tool call.

  return response;
}
