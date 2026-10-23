/**
 * The client-side tool loop (#21 §7).
 *
 * Web search is a provider *server* tool; repository access cannot be, because the
 * provider does not hold our GitHub credential. So the loop runs here: the model asks, we
 * execute, we feed the results back, and it answers.
 *
 * Every rule below came out of the live probe in #24, and skipping any of them produces a
 * silently wrong answer or a 400 rather than an obvious failure:
 *
 *   1. **Branch on stop_reason.** `tool_use` means run the tools and continue;
 *      `pause_turn` means echo the content back with *no* tool_result and continue;
 *      anything else is the final response. A loop that stopped on "no tool_use" would
 *      treat a pause as the answer.
 *   2. **Echo assistant content verbatim.** Never filter, reorder or rebuild blocks. The
 *      two providers order mixed turns differently, both accept only an exact echo, and it
 *      is what preserves Anthropic's signed `thinking` blocks and DeepSeek's `call_00_…`
 *      tool-call ids.
 *   3. **Answer every tool_use in ONE user message**, in block order. Models issue parallel
 *      calls; answering them one at a time is a 400. Block order also makes the content
 *      budget deterministic across them.
 *   4. **Hop cap and time budget**, then a final call with *no* tools, so the user always
 *      gets an answer. The probe showed two of three models retrying a failing tool rather
 *      than giving up.
 *   5. **Text comes from the final response only.** Mid-loop, extractReplyText returns
 *      leading narration on DeepSeek and an empty string on Anthropic.
 */

import {
  extractReplyText,
  type CallModelInput,
  type CallModelResult,
  type ConversationMessage,
  type CustomToolDefinition,
  type ModelProvider,
} from '@/lib/model';
import type { ToolResult } from '@/lib/repoToolsTypes';

export interface HopRecord {
  index: number;
  stopReason: string | null;
  toolCalls: string[];
  usage: CallModelResult['usage'];
  thinkingTokens?: number;
  model: string;
  requestId: string | null;
}

export interface ToolLoopOutcome {
  text: string;
  hops: HopRecord[];
  /** Why the loop ended, which the caller logs and may surface. */
  stoppedBecause: 'final_answer' | 'hop_cap' | 'time_budget';
}

export interface ToolLoopInput {
  provider: ModelProvider;
  /** Everything but the conversation; the loop supplies that. */
  request: Omit<CallModelInput, 'conversation'>;
  tools: CustomToolDefinition[];
  /** Executes one tool call. Errors are returned, not thrown. */
  runTool: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
  maxHops?: number;
  /** Wall-clock budget for the whole loop, so the route's maxDuration is never exceeded. */
  budgetMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_HOPS = 6;
const DEFAULT_BUDGET_MS = 90_000;

export async function runToolLoop(input: ToolLoopInput): Promise<ToolLoopOutcome> {
  const maxHops = input.maxHops ?? DEFAULT_MAX_HOPS;
  const budgetMs = input.budgetMs ?? DEFAULT_BUDGET_MS;
  const now = input.now ?? (() => Date.now());
  const startedAt = now();

  const conversation: ConversationMessage[] = [
    { role: 'user', content: input.request.userMessage },
  ];
  const hops: HopRecord[] = [];

  for (let index = 0; index < maxHops; index++) {
    const response = await input.provider.callModel({
      ...input.request,
      tools: input.tools,
      conversation,
    });

    const content = response.content ?? [];
    const toolUses = content.filter((block: any) => block?.type === 'tool_use');

    hops.push({
      index,
      stopReason: response.stopReason,
      toolCalls: toolUses.map((block: any) => String(block.name)),
      usage: response.usage,
      thinkingTokens: response.thinkingTokens,
      model: response.model,
      requestId: response.requestId,
    });

    // Rule 1: anything that is not a continuation is the answer.
    if (response.stopReason !== 'tool_use' && response.stopReason !== 'pause_turn') {
      return { text: textOf(response), hops, stoppedBecause: 'final_answer' };
    }

    // Rule 2: the assistant's turn goes back exactly as it came.
    conversation.push({ role: 'assistant', content });

    // A pause carries no tool_use to answer; echoing it is the whole continuation.
    if (response.stopReason === 'pause_turn') {
      if (overBudget(now, startedAt, budgetMs)) {
        return finalise(input, conversation, hops, 'time_budget');
      }
      continue;
    }

    if (toolUses.length === 0) {
      // stop_reason said tool_use but no block carries one. Nothing to answer, and
      // continuing would loop; treat what we have as the answer.
      return { text: textOf(response), hops, stoppedBecause: 'final_answer' };
    }

    // Rule 3: one user message carrying every result, in block order.
    const results = [];
    for (const call of toolUses) {
      const result = await input.runTool(String(call.name), (call.input || {}) as Record<string, unknown>);
      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: result.content,
        ...(result.isError ? { is_error: true } : {}),
      });
    }
    conversation.push({ role: 'user', content: results });

    // Rule 4: the cap and the budget are checked after the results are in, so the final
    // call still sees everything the model asked for.
    if (overBudget(now, startedAt, budgetMs)) {
      return finalise(input, conversation, hops, 'time_budget');
    }
  }

  return finalise(input, conversation, hops, 'hop_cap');
}

/**
 * The last call, made with no tools at all, so the model has to answer from what it has.
 * Without it a loop that hits its cap returns nothing to the user.
 */
async function finalise(
  input: ToolLoopInput,
  conversation: ConversationMessage[],
  hops: HopRecord[],
  stoppedBecause: 'hop_cap' | 'time_budget'
): Promise<ToolLoopOutcome> {
  const response = await input.provider.callModel({
    ...input.request,
    tools: undefined,
    conversation,
  });

  hops.push({
    index: hops.length,
    stopReason: response.stopReason,
    toolCalls: [],
    usage: response.usage,
    thinkingTokens: response.thinkingTokens,
    model: response.model,
    requestId: response.requestId,
  });

  return { text: textOf(response), hops, stoppedBecause };
}

/** Rule 5: the provider already extracted it; fall back to the blocks if it did not. */
function textOf(response: CallModelResult): string {
  if (response.text && response.text.trim() !== '') return response.text;
  return extractReplyText(response.content ?? []);
}

function overBudget(now: () => number, startedAt: number, budgetMs: number): boolean {
  return now() - startedAt >= budgetMs;
}
