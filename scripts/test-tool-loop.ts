// Unit tests for the client-side tool loop (#21 §7). Pure: a scripted fake provider, no
// network, no database.
// Run: npx tsx --test scripts/test-tool-loop.ts
//
// The mid-loop response shapes are the real ones from the #24 probe — DeepSeek narrating
// before a tool call, Anthropic emitting a signed thinking block and empty text — because
// the rules exist to survive those exact shapes.

import { test } from 'node:test';
import assert from 'assert';

import { runToolLoop } from '../lib/toolLoop';
import type { CallModelInput, CallModelResult, ModelProvider } from '../lib/model';

const TOOLS = [
  { name: 'read_file', description: 'Read a file', input_schema: { type: 'object' } },
  { name: 'list_tree', description: 'List a tree', input_schema: { type: 'object' } },
];

const usage = { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 };

function reply(partial: Partial<CallModelResult>): CallModelResult {
  return {
    text: '',
    usage,
    model: 'test-model',
    requestId: 'req',
    stopReason: 'end_turn',
    content: [],
    ...partial,
  };
}

/** A provider that plays a scripted list of responses and records what it was sent. */
function scripted(responses: CallModelResult[]) {
  const seen: CallModelInput[] = [];
  const provider: ModelProvider = {
    name: 'anthropic',
    outputFormat: 'markdown',
    callModel: async (input) => {
      seen.push(JSON.parse(JSON.stringify(input)));
      const next = responses.shift();
      if (!next) throw new Error('the loop made more calls than the script allows');
      return next;
    },
  };
  return { provider, seen };
}

function loop(provider: ModelProvider, runTool: any, extra: any = {}) {
  return runToolLoop({
    provider,
    request: {
      systemPrompt: 'system',
      userMessage: 'where is auth handled?',
      model: 'test-model',
      cacheable: true,
      isolationScopeId: 'scope',
    },
    tools: TOOLS,
    runTool,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Rule 1: branch on stop_reason
// ---------------------------------------------------------------------------

test('a response that is not a continuation is the answer', async () => {
  const { provider, seen } = scripted([
    reply({ stopReason: 'end_turn', text: 'auth lives in src/auth.ts', content: [{ type: 'text', text: 'auth lives in src/auth.ts' }] }),
  ]);
  const outcome = await loop(provider, async () => ({ content: 'unused' }));

  assert.strictEqual(outcome.text, 'auth lives in src/auth.ts');
  assert.strictEqual(outcome.stoppedBecause, 'final_answer');
  assert.strictEqual(seen.length, 1);
  assert.deepStrictEqual(seen[0].conversation, [{ role: 'user', content: 'where is auth handled?' }]);
});

// pause_turn is a continuation with nothing to answer. A loop that stopped on "no
// tool_use" would hand the user a half-finished turn.
test('pause_turn continues, echoing content with no tool_result', async () => {
  const paused = [{ type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} }];
  const { provider, seen } = scripted([
    reply({ stopReason: 'pause_turn', content: paused }),
    reply({ stopReason: 'end_turn', text: 'done', content: [{ type: 'text', text: 'done' }] }),
  ]);

  const outcome = await loop(provider, async () => {
    throw new Error('no tool should run for a pause');
  });

  assert.strictEqual(outcome.text, 'done');
  assert.strictEqual(seen.length, 2);
  assert.deepStrictEqual(seen[1].conversation, [
    { role: 'user', content: 'where is auth handled?' },
    { role: 'assistant', content: paused },
  ]);
  assert.strictEqual(outcome.hops.length, 2);
});

// ---------------------------------------------------------------------------
// Rule 2: verbatim echo, in both providers' orderings
// ---------------------------------------------------------------------------

test('assistant content is echoed exactly, never rebuilt', async () => {
  // DeepSeek's ordering, from the probe: narration, then a server tool, then the custom
  // call, then the search result — with a call_00_ style id.
  const deepseekTurn = [
    { type: 'text', text: 'Let me check the repository…' },
    { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'x' } },
    { type: 'tool_use', id: 'call_00_abc', name: 'read_file', input: { path: 'src/auth.ts' } },
    { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [] },
  ];
  const { provider, seen } = scripted([
    reply({ stopReason: 'tool_use', text: 'Let me check the repository…', content: deepseekTurn }),
    reply({ stopReason: 'end_turn', text: 'final', content: [{ type: 'text', text: 'final' }] }),
  ]);

  await loop(provider, async () => ({ content: 'file body' }));

  assert.deepStrictEqual(
    seen[1].conversation?.[1],
    { role: 'assistant', content: deepseekTurn },
    'the echo must preserve order, narration and the server-tool blocks'
  );
});

test("a signed thinking block survives the round trip", async () => {
  // Anthropic's ordering: thinking (signed), then the tool call, and empty text.
  const anthropicTurn = [
    { type: 'thinking', thinking: 'The user wants…', signature: 'sig-abc-123' },
    { type: 'tool_use', id: 'toolu_1', name: 'list_tree', input: { depth: 1 } },
  ];
  const { provider, seen } = scripted([
    reply({ stopReason: 'tool_use', text: '', content: anthropicTurn }),
    reply({ stopReason: 'end_turn', text: 'final', content: [{ type: 'text', text: 'final' }] }),
  ]);

  await loop(provider, async () => ({ content: 'tree' }));

  const echoed = seen[1].conversation?.[1] as any;
  assert.strictEqual(echoed.content[0].signature, 'sig-abc-123', 'the signature must come back intact');
});

// Mid-loop text is narration, not an answer. It must never reach the user.
test('mid-loop narration is not returned as the answer', async () => {
  const { provider } = scripted([
    reply({
      stopReason: 'tool_use',
      text: 'Let me search…',
      content: [{ type: 'text', text: 'Let me search…' }, { type: 'tool_use', id: 't1', name: 'read_file', input: {} }],
    }),
    reply({ stopReason: 'end_turn', text: 'the real answer', content: [{ type: 'text', text: 'the real answer' }] }),
  ]);

  const outcome = await loop(provider, async () => ({ content: 'body' }));
  assert.strictEqual(outcome.text, 'the real answer');
});

// ---------------------------------------------------------------------------
// Rule 3: every parallel call answered in one message, in block order
// ---------------------------------------------------------------------------

test('parallel tool calls are answered in one user message, in order', async () => {
  const turn = [
    { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.ts' } },
    { type: 'tool_use', id: 't2', name: 'read_file', input: { path: 'b.ts' } },
    { type: 'tool_use', id: 't3', name: 'read_file', input: { path: 'c.ts' } },
  ];
  const { provider, seen } = scripted([
    reply({ stopReason: 'tool_use', content: turn }),
    reply({ stopReason: 'end_turn', text: 'done', content: [{ type: 'text', text: 'done' }] }),
  ]);

  const order: string[] = [];
  await loop(provider, async (_name: string, args: any) => {
    order.push(args.path);
    return { content: `body of ${args.path}` };
  });

  assert.deepStrictEqual(order, ['a.ts', 'b.ts', 'c.ts'], 'calls run in block order');

  const resultsMessage = seen[1].conversation?.[2] as any;
  assert.strictEqual(resultsMessage.role, 'user');
  assert.strictEqual(resultsMessage.content.length, 3, 'one message carrying every result');
  assert.deepStrictEqual(
    resultsMessage.content.map((r: any) => r.tool_use_id),
    ['t1', 't2', 't3']
  );
});

test('a tool error is flagged rather than hidden', async () => {
  const { provider, seen } = scripted([
    reply({ stopReason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }] }),
    reply({ stopReason: 'end_turn', text: 'done', content: [{ type: 'text', text: 'done' }] }),
  ]);

  await loop(provider, async () => ({ content: 'That path is not valid.', isError: true }));

  const result = (seen[1].conversation?.[2] as any).content[0];
  assert.strictEqual(result.is_error, true);
  assert.strictEqual(result.content, 'That path is not valid.');
});

// ---------------------------------------------------------------------------
// Rule 4: the cap and the budget always produce an answer
// ---------------------------------------------------------------------------

// The probe showed models retrying a tool that returned is_error, so the cap is not
// theoretical.
test('a model that keeps calling tools is stopped and asked to answer', async () => {
  const keepGoing = () =>
    reply({ stopReason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'read_file', input: {} }] });
  const { provider, seen } = scripted([
    keepGoing(),
    keepGoing(),
    keepGoing(),
    reply({ stopReason: 'end_turn', text: 'answer from what I have', content: [{ type: 'text', text: 'answer from what I have' }] }),
  ]);

  const outcome = await loop(provider, async () => ({ content: 'nope', isError: true }), { maxHops: 3 });

  assert.strictEqual(outcome.stoppedBecause, 'hop_cap');
  assert.strictEqual(outcome.text, 'answer from what I have');
  assert.strictEqual(seen.length, 4, 'three hops, then one final call');
  assert.strictEqual(seen[3].tools, undefined, 'the final call must carry no tools');
});

test('the time budget also ends in a final, tool-free call', async () => {
  let clock = 0;
  const { provider, seen } = scripted([
    reply({ stopReason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'read_file', input: {} }] }),
    reply({ stopReason: 'end_turn', text: 'wrapped up', content: [{ type: 'text', text: 'wrapped up' }] }),
  ]);

  // Each reading advances past the budget, so the check after the first hop's results
  // trips it. (At 600 per reading it did not, and the loop simply finished normally —
  // the test passed for the wrong reason until the assertion caught it.)
  const outcome = await loop(provider, async () => ({ content: 'body' }), {
    maxHops: 10,
    budgetMs: 1000,
    now: () => (clock += 1200),
  });

  assert.strictEqual(outcome.stoppedBecause, 'time_budget');
  assert.strictEqual(outcome.text, 'wrapped up');
  assert.strictEqual(seen[seen.length - 1].tools, undefined);
});

// ---------------------------------------------------------------------------
// Per-hop records, which §8 logs
// ---------------------------------------------------------------------------

test('every hop is recorded, with its tools, usage and thinking tokens', async () => {
  const { provider } = scripted([
    reply({
      stopReason: 'tool_use',
      content: [
        { type: 'tool_use', id: 't1', name: 'list_tree', input: {} },
        { type: 'tool_use', id: 't2', name: 'read_file', input: {} },
      ],
      thinkingTokens: 42,
    }),
    reply({ stopReason: 'end_turn', text: 'done', content: [{ type: 'text', text: 'done' }], thinkingTokens: 7 }),
  ]);

  const outcome = await loop(provider, async () => ({ content: 'x' }));

  assert.strictEqual(outcome.hops.length, 2);
  assert.deepStrictEqual(outcome.hops[0].toolCalls, ['list_tree', 'read_file']);
  assert.strictEqual(outcome.hops[0].thinkingTokens, 42);
  assert.deepStrictEqual(outcome.hops[1].toolCalls, []);
  assert.strictEqual(outcome.hops[1].index, 1);
  assert.strictEqual(outcome.hops[0].usage.input_tokens, 10);
});

// ---------------------------------------------------------------------------
// Prompt-cache stability
// ---------------------------------------------------------------------------

// Tool definitions sit at the start of the cached prefix, so changing the set mid-answer
// resets the cache. Every in-loop call must carry the identical set.
test('the same tool set is sent on every in-loop call', async () => {
  const { provider, seen } = scripted([
    reply({ stopReason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'read_file', input: {} }] }),
    reply({ stopReason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'read_file', input: {} }] }),
    reply({ stopReason: 'end_turn', text: 'done', content: [{ type: 'text', text: 'done' }] }),
  ]);

  await loop(provider, async () => ({ content: 'x' }));

  for (const call of seen) {
    assert.deepStrictEqual(call.tools, TOOLS, 'every call carries the identical tool set');
  }
});

test('a stop_reason of tool_use with no tool_use block does not loop forever', async () => {
  const { provider } = scripted([reply({ stopReason: 'tool_use', text: 'odd', content: [{ type: 'text', text: 'odd' }] })]);
  const outcome = await loop(provider, async () => ({ content: 'x' }));
  assert.strictEqual(outcome.text, 'odd');
  assert.strictEqual(outcome.stoppedBecause, 'final_answer');
});
