// Probe: can a turn containing tool_use / tool_result blocks be completed WITHOUT the
// model calling another tool? (#21 §7, raised in the review of #36.)
//
// Run: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/probe-tool-choice-none.ts
//
// The loop's hop cap and time budget end with a final call whose whole purpose is to make
// the model answer from what it already has. Two ways to express that:
//
//   A. omit `tools` entirely — which the review expects to be rejected, because the
//      conversation still contains tool_use and tool_result blocks;
//   B. keep `tools` and send `tool_choice: { type: 'none' }`.
//
// B also preserves the cached prefix, since the tool set does not change. This probe
// establishes which actually works, on each provider, rather than reasoning about it.
// It sends four small requests and prints a verdict.

import Anthropic from '@anthropic-ai/sdk';

const TOOL = {
  name: 'read_file',
  description: 'Read a file from the repository.',
  input_schema: {
    type: 'object' as const,
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
};

/** A conversation that already contains a completed tool round trip. */
const CONVERSATION: any[] = [
  { role: 'user', content: 'What does src/auth.ts do? Use read_file.' },
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_probe_1', name: 'read_file', input: { path: 'src/auth.ts' } }],
  },
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_probe_1',
        content: 'export function signIn() { /* PROBE-SENTINEL-7Q2 */ }',
      },
    ],
  },
];

interface Target {
  name: string;
  model: string;
  client: Anthropic;
  extra?: Record<string, unknown>;
}

function targets(): Target[] {
  const list: Target[] = [];

  if (process.env.ANTHROPIC_API_KEY) {
    list.push({
      name: 'anthropic',
      model: process.env.PROBE_ANTHROPIC_MODEL || 'claude-sonnet-5',
      client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
    });
  } else {
    console.warn('ANTHROPIC_API_KEY not set — skipping the Anthropic target.');
  }

  if (process.env.DEEPSEEK_API_KEY) {
    list.push({
      name: 'deepseek',
      model: process.env.PROBE_DEEPSEEK_MODEL || 'deepseek-v4-pro',
      client: new Anthropic({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/anthropic' }),
      extra: { thinking: { type: 'disabled' } },
    });
  } else {
    console.warn('DEEPSEEK_API_KEY not set — skipping the DeepSeek target.');
  }

  return list;
}

async function attempt(target: Target, label: string, body: Record<string, unknown>) {
  try {
    const response: any = await target.client.messages.create({
      model: target.model,
      max_tokens: 256,
      system: 'Answer briefly from what you already have.',
      messages: CONVERSATION,
      ...target.extra,
      ...body,
    } as any);

    const text = (response.content || [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('')
      .trim();
    const calledAgain = (response.content || []).some((b: any) => b.type === 'tool_use');

    console.log(
      `  ${label.padEnd(34)} OK    stop=${response.stop_reason} toolCallAgain=${calledAgain} text=${JSON.stringify(text.slice(0, 60))}`
    );
    return { ok: true, calledAgain };
  } catch (err: any) {
    const detail = err?.status ? `${err.status} ${err?.error?.error?.message || err.message}` : err?.message;
    console.log(`  ${label.padEnd(34)} FAIL  ${String(detail).slice(0, 140)}`);
    return { ok: false, calledAgain: false };
  }
}

async function main() {
  const list = targets();
  if (list.length === 0) {
    console.error('No API keys available; nothing to probe.');
    process.exit(1);
  }

  for (const target of list) {
    console.log(`\n=== ${target.name} (${target.model}) ===`);
    const omitted = await attempt(target, 'A: tools omitted', {});
    const choiceNone = await attempt(target, 'B: tools + tool_choice none', {
      tools: [TOOL],
      tool_choice: { type: 'none' },
    });

    console.log(
      `  VERDICT: ${
        choiceNone.ok && !choiceNone.calledAgain
          ? 'use B (tools + tool_choice:none)'
          : omitted.ok
            ? 'B unavailable; A works'
            : 'neither worked — investigate'
      }`
    );
  }
}

main();
