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
  /** Provider-side web searches made in this hop, for the per-hop ledger rows (§8). */
  webSearchRequests?: number;
  model: string;
  requestId: string | null;
}

export interface ToolLoopOutcome {
  text: string;
  hops: HopRecord[];
  /** Why the loop ended, which the caller logs and may surface. */
  stoppedBecause: 'final_answer' | 'hop_cap' | 'time_budget' | 'truncated_turn';
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
  /**
   * Most tool calls one hop may make. The session's byte budget limits how much *content*
   * comes back, but not how many GitHub requests a model can ask for in a single turn.
   */
  maxToolCallsPerHop?: number;
  /**
   * How long the final call may take, beyond the budget. It is a separate allowance
   * because it runs *after* the budget is spent: the point of cancelling a hop at the
   * deadline is to leave room for an answer, so the route's maxDuration must cover
   * budgetMs + finaliseMs and not budgetMs alone.
   */
  finaliseMs?: number;
  /**
   * Called before each hop's tools run, so a caller can tell the user what is happening —
   * 90 seconds is a long time to watch a typing indicator. `input` is model-supplied: it
   * must be normalised and escaped before it is shown to anyone.
   */
  onProgress?: (progress: { hop: number; calls: Array<{ name: string; input: Record<string, unknown> }> }) => void | Promise<void>;
  now?: () => number;
}

const DEFAULT_MAX_HOPS = 6;
const DEFAULT_BUDGET_MS = 90_000;
const DEFAULT_MAX_TOOL_CALLS_PER_HOP = 8;
const DEFAULT_FINALISE_MS = 20_000;

export async function runToolLoop(input: ToolLoopInput): Promise<ToolLoopOutcome> {
  const maxHops = input.maxHops ?? DEFAULT_MAX_HOPS;
  const budgetMs = input.budgetMs ?? DEFAULT_BUDGET_MS;
  const maxCalls = input.maxToolCallsPerHop ?? DEFAULT_MAX_TOOL_CALLS_PER_HOP;
  const finaliseMs = input.finaliseMs ?? DEFAULT_FINALISE_MS;
  const now = input.now ?? (() => Date.now());
  const startedAt = now();

  const conversation: ConversationMessage[] = [firstTurn(input.request)];
  const hops: HopRecord[] = [];

  for (let index = 0; index < maxHops; index++) {
    // What is left of the budget — but never less than the final call's own allowance.
    // Whether to make another hop is decided after the previous hop's results (rule 4);
    // this only bounds the call once it is under way, and a hop that has already begun
    // must not be handed a deadline too short to answer within, or the budget would turn
    // "stop looping" into "produce nothing".
    const allowance = Math.max(budgetMs - (now() - startedAt), finaliseMs);

    let response: CallModelResult;
    try {
      response = await input.provider.callModel({
        ...input.request,
        tools: input.tools,
        conversation,
        // Cancelled at the deadline rather than waited out. Without this the budget only
        // stops the loop *between* hops, so one slow call could run past the route's
        // maxDuration and take the answer, not just the hop, down with it.
        signal: deadlineSignal(allowance),
      });
    } catch (err) {
      if (!isAbort(err)) throw err;
      // The hop was cut off mid-flight, so `conversation` still ends with tool results
      // (or the question) and is a valid turn to answer from.
      console.warn(`Tool loop: hop ${index} cancelled at the time budget; finalising.`);
      return finalise(input, conversation, hops, 'time_budget');
    }

    const content = response.content ?? [];
    const toolUses = content.filter((block: any) => block?.type === 'tool_use');

    hops.push({
      index,
      stopReason: response.stopReason,
      toolCalls: toolUses.map((block: any) => String(block.name)),
      usage: response.usage,
      thinkingTokens: response.thinkingTokens,
      webSearchRequests: response.webSearchRequests,
      model: response.model,
      requestId: response.requestId,
    });

    // Rule 1: anything that is not a continuation is the answer.
    if (response.stopReason !== 'tool_use' && response.stopReason !== 'pause_turn') {
      if (toolUses.length > 0) {
        // The turn was cut off mid-call (max_tokens, usually), so its text is truncated
        // narration rather than an answer, and the calls cannot be answered reliably.
        // Ask once more for an answer from what is already there.
        console.warn(
          `Tool loop: stop_reason=${response.stopReason} with ${toolUses.length} tool_use block(s); finalising instead.`
        );
        conversation.push({ role: 'assistant', content: content.filter((b: any) => b?.type !== 'tool_use') });
        return finalise(input, conversation, hops, 'truncated_turn');
      }
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

    if (input.onProgress) {
      try {
        await input.onProgress({
          hop: index,
          calls: toolUses.map((block: any) => ({
            name: String(block.name),
            input: (block.input || {}) as Record<string, unknown>,
          })),
        });
      } catch (err) {
        // Telling the user what is happening is a courtesy; failing at it must not cost
        // them the answer.
        console.warn('Tool-loop progress callback failed:', err);
      }
    }

    // Rule 3: one user message carrying every result, in block order. EVERY tool_use must
    // get a tool_result, including the ones past the cap — a missing result is a 400.
    const results = [];
    for (const [position, call] of toolUses.entries()) {
      if (position >= maxCalls) {
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: `Too many tool calls in one step; I answered the first ${maxCalls}.`,
          is_error: true,
        });
        continue;
      }

      let result: ToolResult;
      try {
        result = await input.runTool(String(call.name), (call.input || {}) as Record<string, unknown>);
      } catch (err) {
        // The contract says tools return errors rather than throwing, but nothing enforces
        // it. One exception must not lose the whole answer — and every tool_use still
        // needs its tool_result.
        console.error(`Tool ${String(call.name)} threw:`, err);
        result = { content: 'That tool failed. Try something else.', isError: true };
      }

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
  stoppedBecause: 'hop_cap' | 'time_budget' | 'truncated_turn'
): Promise<ToolLoopOutcome> {
  let response: CallModelResult;
  try {
    response = await input.provider.callModel({
      ...input.request,
      // The SAME tools, with tool_choice none. Both providers accept the call with `tools`
      // omitted — probed, see scripts/probe-tool-choice-none.ts — but omitting them changes
      // the cached prefix, and this is the call with the most context behind it.
      tools: input.tools,
      toolChoice: { type: 'none' },
      conversation,
      // Its own allowance, started now: the budget this call follows is already spent.
      signal: deadlineSignal(input.finaliseMs ?? DEFAULT_FINALISE_MS),
    });
  } catch (err) {
    if (!isAbort(err)) throw err;
    // Nothing left to ask with. The caller decides what to say; it must not be a throw,
    // because the hops are worth logging either way.
    console.warn('Tool loop: the final call was cancelled; returning no text.');
    return { text: '', hops, stoppedBecause };
  }

  hops.push({
    index: hops.length,
    stopReason: response.stopReason,
    toolCalls: [],
    usage: response.usage,
    thinkingTokens: response.thinkingTokens,
    webSearchRequests: response.webSearchRequests,
    model: response.model,
    requestId: response.requestId,
  });

  return { text: textOf(response), hops, stoppedBecause };
}

/**
 * The first turn, built exactly as the providers build it — including an attached
 * document, which `conversation` would otherwise replace and silently drop.
 */
function firstTurn(request: Omit<CallModelInput, 'conversation'>): ConversationMessage {
  if (!request.document) {
    return { role: 'user', content: request.userMessage };
  }
  return {
    role: 'user',
    content: [
      {
        type: 'document',
        source: { type: 'base64', media_type: request.document.mediaType, data: request.document.data },
      },
      { type: 'text', text: request.userMessage },
    ],
  };
}

/** Rule 5: the provider already extracted it; fall back to the blocks if it did not. */
function textOf(response: CallModelResult): string {
  if (response.text && response.text.trim() !== '') return response.text;
  return extractReplyText(response.content ?? []);
}

function overBudget(now: () => number, startedAt: number, budgetMs: number): boolean {
  return now() - startedAt >= budgetMs;
}

/**
 * A signal that fires after `ms`. AbortSignal.timeout rather than a setTimeout we would
 * have to clear: an uncleared timer holds the function open past the answer.
 */
function deadlineSignal(ms: number): AbortSignal {
  return AbortSignal.timeout(Math.max(1, Math.floor(ms)));
}

/**
 * Both shapes a cancelled call arrives as: the DOM-style AbortError, and the TimeoutError
 * that AbortSignal.timeout produces.
 */
function isAbort(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}
