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
  // The tools stay attached so the cached prefix does not change; tool_choice is what
  // makes the model answer. Both providers accept the call with tools omitted too —
  // probed — but that resets the cache on the most expensive call of the answer.
  assert.deepStrictEqual(seen[3].tools, TOOLS, 'the final call keeps the same tool set');
  assert.deepStrictEqual(seen[3].toolChoice, { type: 'none' }, 'and forbids another call');
});

test('the time budget also ends in a final, answer-only call', async () => {
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
  assert.deepStrictEqual(seen[seen.length - 1].toolChoice, { type: 'none' });
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

// ---------------------------------------------------------------------------
// Review follow-ups (#36)
// ---------------------------------------------------------------------------

// The contract says tools return errors rather than throwing, but nothing enforces it.
// One exception must not cost the user the answer — and every tool_use still needs a
// tool_result, or the next request is a 400.
test('a tool that throws becomes an error result, not a lost answer', async () => {
  const { provider, seen } = scripted([
    reply({
      stopReason: 'tool_use',
      content: [
        { type: 'tool_use', id: 't1', name: 'read_file', input: {} },
        { type: 'tool_use', id: 't2', name: 'list_tree', input: {} },
      ],
    }),
    reply({ stopReason: 'end_turn', text: 'answered anyway', content: [{ type: 'text', text: 'answered anyway' }] }),
  ]);

  const outcome = await loop(provider, async (name: string) => {
    if (name === 'read_file') throw new Error('boom');
    return { content: 'tree listing' };
  });

  assert.strictEqual(outcome.text, 'answered anyway');
  const results = (seen[1].conversation?.[2] as any).content;
  assert.strictEqual(results.length, 2, 'every tool_use still gets a tool_result');
  assert.strictEqual(results[0].is_error, true);
  assert.match(results[0].content, /tool failed/i);
  assert.strictEqual(results[1].content, 'tree listing');
});

// The session's byte budget caps content, not the number of GitHub requests.
test('tool calls per hop are capped, and the extras still get results', async () => {
  const many = Array.from({ length: 5 }, (_, i) => ({
    type: 'tool_use',
    id: `t${i}`,
    name: 'read_file',
    input: { path: `f${i}.ts` },
  }));
  const { provider, seen } = scripted([
    reply({ stopReason: 'tool_use', content: many }),
    reply({ stopReason: 'end_turn', text: 'done', content: [{ type: 'text', text: 'done' }] }),
  ]);

  let ran = 0;
  await loop(
    provider,
    async () => {
      ran++;
      return { content: 'body' };
    },
    { maxToolCallsPerHop: 2 }
  );

  assert.strictEqual(ran, 2, 'only the first two run');
  const results = (seen[1].conversation?.[2] as any).content;
  assert.strictEqual(results.length, 5, 'but all five are answered, or the next call is a 400');
  assert.strictEqual(results[4].is_error, true);
  assert.match(results[4].content, /Too many tool calls/);
});

// An attached document would otherwise be dropped: `conversation` replaces the branch in
// the provider that builds the document block.
test('an attached document survives into the first turn', async () => {
  const { provider, seen } = scripted([
    reply({ stopReason: 'end_turn', text: 'read it', content: [{ type: 'text', text: 'read it' }] }),
  ]);

  await runToolLoop({
    provider,
    request: {
      systemPrompt: 'system',
      userMessage: 'summarise this',
      model: 'test-model',
      cacheable: true,
      isolationScopeId: 'scope',
      document: { data: 'YmFzZTY0', mediaType: 'application/pdf' },
    },
    tools: TOOLS,
    runTool: async () => ({ content: 'x' }),
  });

  const first = seen[0].conversation?.[0] as any;
  assert.strictEqual(Array.isArray(first.content), true);
  assert.strictEqual(first.content[0].type, 'document');
  assert.strictEqual(first.content[0].source.data, 'YmFzZTY0');
  assert.strictEqual(first.content[1].text, 'summarise this');
});

// A turn cut off mid-call carries truncated narration, not an answer, and its tool calls
// cannot be answered reliably.
test('a turn truncated mid-tool-call is finalised rather than returned', async () => {
  const { provider, seen } = scripted([
    reply({
      stopReason: 'max_tokens',
      text: 'Let me look at',
      content: [
        { type: 'text', text: 'Let me look at' },
        { type: 'tool_use', id: 't1', name: 'read_file', input: {} },
      ],
    }),
    reply({ stopReason: 'end_turn', text: 'a proper answer', content: [{ type: 'text', text: 'a proper answer' }] }),
  ]);

  const outcome = await loop(provider, async () => ({ content: 'x' }));

  assert.strictEqual(outcome.stoppedBecause, 'truncated_turn');
  assert.strictEqual(outcome.text, 'a proper answer');
  // The truncated tool_use block is not echoed back: it would demand a tool_result we are
  // deliberately not sending.
  const echoed = (seen[1].conversation?.[1] as any).content;
  assert.strictEqual(echoed.some((b: any) => b.type === 'tool_use'), false);
});

// 90 seconds is a long time to watch a typing indicator.
test('progress is reported before each hop runs its tools', async () => {
  const { provider } = scripted([
    reply({
      stopReason: 'tool_use',
      content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'src/auth.ts' } }],
    }),
    reply({ stopReason: 'end_turn', text: 'done', content: [{ type: 'text', text: 'done' }] }),
  ]);

  const seenProgress: any[] = [];
  await loop(provider, async () => ({ content: 'body' }), {
    onProgress: (p: any) => {
      seenProgress.push(p);
    },
  });

  assert.strictEqual(seenProgress.length, 1);
  assert.strictEqual(seenProgress[0].hop, 0);
  assert.deepStrictEqual(seenProgress[0].calls, [{ name: 'read_file', input: { path: 'src/auth.ts' } }]);
});

test('a failing progress callback does not cost the answer', async () => {
  const { provider } = scripted([
    reply({ stopReason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }] }),
    reply({ stopReason: 'end_turn', text: 'still answered', content: [{ type: 'text', text: 'still answered' }] }),
  ]);

  const outcome = await loop(provider, async () => ({ content: 'body' }), {
    onProgress: () => {
      throw new Error('telegram edit failed');
    },
  });

  assert.strictEqual(outcome.text, 'still answered');
});

// ---------------------------------------------------------------------------
// Cancellation: the budget cuts a call off mid-flight, not only between hops
// ---------------------------------------------------------------------------

/** What a provider throws when its AbortSignal fires. */
function abortError(name: 'AbortError' | 'TimeoutError'): Error {
  const err = new Error('aborted');
  err.name = name;
  return err;
}

test('every call carries a deadline signal', async () => {
  const { provider, seen } = scripted([
    reply({ stopReason: 'end_turn', text: 'done', content: [{ type: 'text', text: 'done' }] }),
  ]);
  // JSON round-tripping in `scripted` drops the signal, so this reads it directly.
  let captured: AbortSignal | undefined;
  const wrapped = {
    ...provider,
    callModel: async (input: CallModelInput) => {
      captured = input.signal;
      return provider.callModel(input);
    },
  };

  await loop(wrapped, async () => ({ content: 'unused' }));

  assert.ok(captured instanceof AbortSignal, 'the hop was given a signal');
  assert.strictEqual(captured!.aborted, false, 'and it had not already fired');
  assert.strictEqual(seen.length, 1);
});

for (const name of ['AbortError', 'TimeoutError'] as const) {
  test(`a hop cancelled with ${name} still produces an answer`, async () => {
    let calls = 0;
    const provider: ModelProvider = {
      name: 'anthropic',
      outputFormat: 'markdown',
      callModel: async () => {
        calls++;
        // The first call is cut off; the final one answers from the question alone.
        if (calls === 1) throw abortError(name);
        return reply({
          stopReason: 'end_turn',
          text: 'I ran out of time, but here is what I know',
          content: [{ type: 'text', text: 'I ran out of time, but here is what I know' }],
        });
      },
    };

    const outcome = await loop(provider, async () => ({ content: 'unused' }));

    assert.strictEqual(outcome.stoppedBecause, 'time_budget');
    assert.strictEqual(outcome.text, 'I ran out of time, but here is what I know');
    assert.strictEqual(calls, 2, 'the cancelled hop was followed by the final call');
  });
}

test('a cancelled final call returns no text rather than throwing', async () => {
  // The hops are still worth logging (§8), so this must not become an exception.
  const provider: ModelProvider = {
    name: 'anthropic',
    outputFormat: 'markdown',
    callModel: async () => {
      throw abortError('TimeoutError');
    },
  };

  const outcome = await loop(provider, async () => ({ content: 'unused' }));

  assert.strictEqual(outcome.text, '');
  assert.strictEqual(outcome.stoppedBecause, 'time_budget');
});

test('a provider failure that is not an abort still throws', async () => {
  const provider: ModelProvider = {
    name: 'anthropic',
    outputFormat: 'markdown',
    callModel: async () => {
      throw new Error('500 from the provider');
    },
  };

  await assert.rejects(() => loop(provider, async () => ({ content: 'unused' })), /500 from the provider/);
});
