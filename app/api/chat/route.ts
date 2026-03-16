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
  getTurn,
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
    // First message in a forked thread — prepend branch context header.
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

  const result = await streamText({
    model: baseten(MODEL),
    system: SYSTEM_PROMPT,
    messages,
    onFinish: async ({ text }) => {
      // Persist the assistant turn.
      addTurn({
        threadId,
        parentTurnId: userTurn.id,
        role: 'assistant',
        content: text,
      });

      // v1 fork detection: string match on completed response text.
      // TODO: replace with suggest_fork tool call for real-time, typed detection.
      const fork = detectFork(text);
      if (fork.detected) {
        console.log(`[fork detected] Path A: ${fork.pathA} | Path B: ${fork.pathB}`);
        // Fork metadata is logged here. Surfacing it to the client over a
        // streaming response requires either a trailing data annotation or
        // a follow-up GET. The suggest_fork tool call approach handles this
        // cleanly via toolCall stream events — another reason to migrate.
      }
    },
  });

  return result.toDataStreamResponse();
}
