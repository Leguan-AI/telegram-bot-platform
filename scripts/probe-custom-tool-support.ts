// scripts/probe-custom-tool-support.ts
//
// Issue #21, Step 0 gate: does a provider's Anthropic-shaped endpoint support
// CUSTOM (client-side) tools, including the tool_use -> tool_result round trip,
// and can a single turn combine its web_search SERVER tool with custom tools?
//
// The issue says "the whole design assumes the tool loop works on every provider",
// so this probes BOTH provider seams, each with the request shape its provider uses:
//
//   deepseek  -> https://api.deepseek.com/anthropic, thinking disabled, no cache_control
//                (lib/providers/deepseek.ts)
//   anthropic -> api.anthropic.com, cache_control: ephemeral on the system block plus the
//                prompt-caching beta header, no thinking param
//                (lib/providers/anthropic.ts, cacheable: true — the normal answer path)
//
// It does NOT touch the database and needs no DB env.
//
// Run: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/probe-custom-tool-support.ts
//
// Env:
//   PROBE_TARGETS          optional, comma-separated: deepseek,anthropic. Default: both
//   DEEPSEEK_API_KEY       required for the deepseek target (skipped without it)
//   ANTHROPIC_API_KEY      required for the anthropic target (skipped without it)
//   DEEPSEEK_PROBE_MODELS  optional. Default: deepseek-flash,deepseek-v4-pro
//   ANTHROPIC_PROBE_MODELS optional. Default: MODEL_IDENTIFIER when it is a claude-* id,
//                          else claude-sonnet-5
//   PROBE_DUMP             optional path; writes every raw request/response as JSON.
//                          Transcripts hold request and response bodies only, never keys,
//                          but .gitignore only covers probe-dump*.json / *-probe-dump.json —
//                          write dumps outside the repo, or match one of those names.
//   PROBE_REQUIRE_ALL      optional; 1 makes an unreachable requested target an error
//
// Exit codes: 0 gate passed, 1 a blocking probe failed, 2 no target was reached
// (nothing proven), 3 PROBE_REQUIRE_ALL=1 with a target left unproven.
//
// Cost note: the mixed-tools probes run real searches. DeepSeek charges no per-search
// surcharge; Anthropic web_search is $10/1k searches, so the anthropic target costs a
// few cents per run.
//
// Blocking probes (1-5) decide the gate. Probe 6 is informational only.

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import { extractReplyText } from '../lib/model';

type Target = {
  name: string;
  models: string[];
  client: Anthropic;
  // Extra top-level request fields this provider sends (e.g. thinking: disabled).
  requestExtras: Record<string, any>;
  // Whether to mark the system block cacheable, the way AnthropicProvider does.
  cacheSystemBlock: boolean;
  requestOptions?: Record<string, any>;
};

const MAX_TOKENS = 2048;
const SCOPE_ID = 'probe-issue-21-step-0';

// Sentinels: strings that exist nowhere on the public web and nowhere in the prompt,
// so finding one in the final answer proves the tool_result content reached the model.
const FILE_SENTINEL = 'ZEPHYR-7731-QUASAR';
const TREE_SENTINEL = 'lib/widget-glorp.ts';

const dumpPath = process.env.PROBE_DUMP;
const transcript: any[] = [];

function buildTargets(): { targets: Target[]; skipped: string[] } {
  const requested = (process.env.PROBE_TARGETS || 'deepseek,anthropic')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  const targets: Target[] = [];
  const skipped: string[] = [];

  for (const name of requested) {
    if (name === 'deepseek') {
      const apiKey = process.env.DEEPSEEK_API_KEY;
      if (!apiKey) {
        skipped.push('deepseek (DEEPSEEK_API_KEY not set)');
        continue;
      }
      targets.push({
        name: 'deepseek',
        models: (process.env.DEEPSEEK_PROBE_MODELS || 'deepseek-flash,deepseek-v4-pro')
          .split(',')
          .map((m) => m.trim())
          .filter(Boolean),
        client: new Anthropic({ apiKey, baseURL: 'https://api.deepseek.com/anthropic' }),
        // Matches lib/providers/deepseek.ts: reasoning tokens are billable output we don't need.
        requestExtras: { thinking: { type: 'disabled' } },
        cacheSystemBlock: false,
      });
    } else if (name === 'anthropic') {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        skipped.push('anthropic (ANTHROPIC_API_KEY not set)');
        continue;
      }
      const configured = process.env.MODEL_IDENTIFIER;
      const defaultModels = configured?.startsWith('claude-') ? configured : 'claude-sonnet-5';
      targets.push({
        name: 'anthropic',
        models: (process.env.ANTHROPIC_PROBE_MODELS || defaultModels)
          .split(',')
          .map((m) => m.trim())
          .filter(Boolean),
        client: new Anthropic({ apiKey }),
        requestExtras: {},
        // Matches lib/providers/anthropic.ts on the normal answer path (cacheable: true).
        // The prompt-caching beta header is obsolete for current models (caching is GA), but
        // it is what prod sends, and the point of this probe is to mirror prod exactly.
        cacheSystemBlock: true,
        requestOptions: { headers: { 'anthropic-beta': 'prompt-caching-2024-07-31' } },
      });
    } else {
      skipped.push(`${name} (unknown target)`);
    }
  }

  return { targets, skipped };
}

// A stand-in for the issue's repo tools (§5: list_tree, read_file, search_code).
const READ_FILE_TOOL = {
  name: 'read_file',
  description:
    'Read a file from the connected repository at the pinned commit. ' +
    'Returns the file contents as text. Use this when the question needs the actual code.',
  input_schema: {
    type: 'object' as const,
    properties: {
      path: { type: 'string', description: 'Repository-relative file path, e.g. "lib/auth.ts".' },
    },
    required: ['path'],
  },
};

const LIST_TREE_TOOL = {
  name: 'list_tree',
  description:
    'List file paths in the connected repository at the pinned commit, optionally under a subdirectory. ' +
    'Call this first when you do not know which file to read.',
  input_schema: {
    type: 'object' as const,
    properties: {
      path: { type: 'string', description: 'Repository-relative directory, or "" for the repo root.' },
    },
    required: ['path'],
  },
};

const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 3,
};

const REPO_SYSTEM_PROMPT =
  'You are a helpful assistant for a software team. ' +
  'A private repository is connected and readable through your tools. ' +
  'When a question needs repository content, call the repository tools instead of guessing. ' +
  'Never invent file contents.';

type ProbeStatus = 'PASS' | 'FAIL' | 'INFO' | 'SKIP';

type ProbeOutcome = {
  target: string;
  model: string;
  probe: string;
  blocking: boolean;
  status: ProbeStatus;
  detail: string;
};

const outcomes: ProbeOutcome[] = [];

function record(o: ProbeOutcome) {
  outcomes.push(o);
  const tag =
    o.status === 'PASS' ? '✅' : o.status === 'FAIL' ? '❌' : o.status === 'SKIP' ? '⏭️ ' : 'ℹ️ ';
  console.log(`${tag} [${o.target}/${o.model}] ${o.probe}: ${o.detail}`);
}

function systemBlock(target: Target) {
  const block: any = { type: 'text', text: REPO_SYSTEM_PROMPT };
  if (target.cacheSystemBlock) block.cache_control = { type: 'ephemeral' };
  return [block];
}

async function create(label: string, target: Target, model: string, params: Record<string, any>) {
  const body: any = {
    model,
    max_tokens: MAX_TOKENS,
    system: systemBlock(target),
    metadata: { user_id: SCOPE_ID },
    ...target.requestExtras,
    ...params,
  };
  const response: any = await target.client.messages.create(body, target.requestOptions ?? {});
  if (dumpPath) transcript.push({ label, target: target.name, model, request: body, response });
  return response;
}

function blocksOf(response: any, type: string): any[] {
  return (response?.content ?? []).filter((b: any) => b?.type === type);
}

function shapeOf(response: any): string {
  return `[${(response?.content ?? []).map((b: any) => b?.type).join(', ')}]`;
}

function errText(err: any): string {
  const status = err?.status ? `HTTP ${err.status} ` : '';
  const body = err?.error ? JSON.stringify(err.error) : (err?.message ?? String(err));
  return `${status}${body}`.slice(0, 400);
}

function isAuthError(err: any): boolean {
  return err?.status === 401 || err?.status === 403;
}

// ---------------------------------------------------------------------------
// Probe 1 + 2: custom tool emission, then the tool_use -> tool_result round trip.
// Probe 1 asks a question only read_file can answer; Probe 2 feeds the result back
// and checks the sentinel reaches the final answer.
// ---------------------------------------------------------------------------
async function probeRoundTrip(target: Target, model: string) {
  const question =
    'What value is assigned to API_VERSION in config/release.ts in our repo? ' +
    'Read the file, then quote the value exactly.';

  let first: any;
  try {
    first = await create('probe1-tool_use', target, model, {
      tools: [READ_FILE_TOOL],
      messages: [{ role: 'user', content: question }],
    });
  } catch (err: any) {
    const status: ProbeStatus = isAuthError(err) ? 'SKIP' : 'FAIL';
    const reason = isAuthError(err)
      ? `credentials rejected, target unreachable: ${errText(err)}`
      : `request rejected: ${errText(err)}`;
    record({ target: target.name, model, probe: 'P1 custom tool accepted + tool_use emitted', blocking: true, status, detail: reason });
    record({ target: target.name, model, probe: 'P2 tool_result round trip', blocking: true, status, detail: 'skipped (P1 did not complete)' });
    return status === 'SKIP' ? 'unreachable' : 'failed';
  }

  const toolUses = blocksOf(first, 'tool_use');
  if (toolUses.length === 0 || first.stop_reason !== 'tool_use') {
    record({
      target: target.name,
      model,
      probe: 'P1 custom tool accepted + tool_use emitted',
      blocking: true,
      status: 'FAIL',
      detail: `no tool_use block. stop_reason=${first.stop_reason} content=${shapeOf(first)}`,
    });
    record({ target: target.name, model, probe: 'P2 tool_result round trip', blocking: true, status: 'FAIL', detail: 'skipped (no tool_use to answer)' });
    return 'failed';
  }

  const call = toolUses[0];
  const schemaOk =
    call.name === 'read_file' && typeof call.input?.path === 'string' && call.input.path.length > 0;
  record({
    target: target.name,
    model,
    probe: 'P1 custom tool accepted + tool_use emitted',
    blocking: true,
    status: schemaOk ? 'PASS' : 'FAIL',
    detail: schemaOk
      ? `stop_reason=${first.stop_reason}, content=${shapeOf(first)}, call=${call.name}(${JSON.stringify(call.input)}), id=${call.id}`
      : `tool_use present but malformed: name=${call.name} input=${JSON.stringify(call.input)}`,
  });

  // Feed a synthetic file body back as tool_result. The sentinel is the proof carrier.
  let second: any;
  try {
    second = await create('probe2-tool_result', target, model, {
      tools: [READ_FILE_TOOL],
      messages: [
        { role: 'user', content: question },
        { role: 'assistant', content: first.content },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: call.id,
              content: `// config/release.ts\nexport const API_VERSION = '${FILE_SENTINEL}';\n`,
            },
          ],
        },
      ],
    });
  } catch (err: any) {
    record({ target: target.name, model, probe: 'P2 tool_result round trip', blocking: true, status: 'FAIL', detail: `tool_result rejected: ${errText(err)}` });
    return 'ok';
  }

  const answer = extractReplyText(second.content);
  const ok = answer.includes(FILE_SENTINEL);
  record({
    target: target.name,
    model,
    probe: 'P2 tool_result round trip',
    blocking: true,
    status: ok ? 'PASS' : 'FAIL',
    detail: ok
      ? `sentinel returned in final answer. stop_reason=${second.stop_reason}, content=${shapeOf(second)}`
      : `sentinel missing. stop_reason=${second.stop_reason}, content=${shapeOf(second)}, answer="${answer.slice(0, 200)}"`,
  });
  return 'ok';
}

// ---------------------------------------------------------------------------
// Probe 3: multi-step loop over two custom tools (list_tree -> read_file).
// The issue's design needs more than one hop per answer, so prove the loop, not
// just a single call.
// ---------------------------------------------------------------------------
async function probeMultiStepLoop(target: Target, model: string) {
  const messages: any[] = [
    {
      role: 'user',
      content:
        'Which file in our repo defines the widget rendering helper, and what does its only exported ' +
        'constant equal? You do not know the repo layout, so list it first, then read the right file.',
    },
  ];

  const served: string[] = [];
  let finalAnswer = '';
  let hops = 0;

  try {
    for (let i = 0; i < 4; i++) {
      const response: any = await create(`probe3-hop${i + 1}`, target, model, {
        tools: [LIST_TREE_TOOL, READ_FILE_TOOL],
        messages,
      });

      const toolUses = blocksOf(response, 'tool_use');
      if (toolUses.length === 0) {
        finalAnswer = extractReplyText(response.content);
        break;
      }

      hops++;
      messages.push({ role: 'assistant', content: response.content });
      messages.push({
        role: 'user',
        content: toolUses.map((t: any) => {
          served.push(t.name);
          const body =
            t.name === 'list_tree'
              ? `lib/auth.ts\nlib/model.ts\n${TREE_SENTINEL}\n`
              : `// ${TREE_SENTINEL}\nexport const GLORP_TOKEN = '${FILE_SENTINEL}';\n`;
          return { type: 'tool_result', tool_use_id: t.id, content: body };
        }),
      });
    }
  } catch (err: any) {
    record({ target: target.name, model, probe: 'P3 multi-step custom tool loop', blocking: true, status: 'FAIL', detail: `loop failed at hop ${hops + 1}: ${errText(err)}` });
    return;
  }

  const ok = hops >= 2 && served.includes('list_tree') && finalAnswer.includes(FILE_SENTINEL);
  record({
    target: target.name,
    model,
    probe: 'P3 multi-step custom tool loop',
    blocking: true,
    status: ok ? 'PASS' : 'FAIL',
    detail: ok
      ? `${hops} tool hops (${served.join(' -> ')}), sentinel reached the final answer`
      : `hops=${hops} served=[${served.join(', ')}] sentinel=${finalAnswer.includes(FILE_SENTINEL)} answer="${finalAnswer.slice(0, 200)}"`,
  });
}

// ---------------------------------------------------------------------------
// Probe 4: is a tools array holding BOTH the web_search server tool and custom
// tools accepted at all? A 400 here would sink the whole design.
// ---------------------------------------------------------------------------
async function probeMixedToolsAccepted(target: Target, model: string) {
  try {
    const response: any = await create('probe4-mixed-accepted', target, model, {
      tools: [WEB_SEARCH_TOOL, LIST_TREE_TOOL, READ_FILE_TOOL],
      messages: [{ role: 'user', content: 'Say "ready" and nothing else.' }],
    });
    record({
      target: target.name,
      model,
      probe: 'P4 web_search + custom tools in one request',
      blocking: true,
      status: 'PASS',
      detail: `accepted. stop_reason=${response.stop_reason}, content=${shapeOf(response)}`,
    });
    return true;
  } catch (err: any) {
    record({ target: target.name, model, probe: 'P4 web_search + custom tools in one request', blocking: true, status: 'FAIL', detail: `rejected: ${errText(err)}` });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Probe 5: one answer that needs BOTH — a web fact and a repo read. Does the
// model actually drive the server tool and a custom tool in the same turn?
//
// Handles stop_reason: 'pause_turn' (a server-tool continuation with no tool_result
// to send) separately from a custom tool_use hop.
// ---------------------------------------------------------------------------
async function probeMixedToolsInOneTurn(target: Target, model: string) {
  const messages: any[] = [
    {
      role: 'user',
      content:
        'Two things in one answer: (1) search the web for the current stable Node.js LTS major version, ' +
        'and (2) read our repo file .nvmrc to see which major version we pin. Then say whether they match. ' +
        'Quote the exact contents of .nvmrc in your answer.',
    },
  ];

  let sawServerTool = false;
  let sawCustomTool = false;
  let pauseTurns = 0;
  let searchRequests = 0;
  let finalAnswer = '';
  const shapes: string[] = [];

  try {
    for (let i = 0; i < 6; i++) {
      const response: any = await create(`probe5-hop${i + 1}`, target, model, {
        tools: [WEB_SEARCH_TOOL, READ_FILE_TOOL],
        messages,
      });

      shapes.push(`${shapeOf(response)}:${response.stop_reason}`);
      if (blocksOf(response, 'web_search_tool_result').length > 0) sawServerTool = true;
      searchRequests += response.usage?.server_tool_use?.web_search_requests ?? 0;

      const toolUses = blocksOf(response, 'tool_use');

      if (toolUses.length === 0) {
        // A paused turn is not an answer: hand the content back and let it continue.
        if (response.stop_reason === 'pause_turn') {
          pauseTurns++;
          messages.push({ role: 'assistant', content: response.content });
          continue;
        }
        finalAnswer = extractReplyText(response.content);
        break;
      }

      // Name-checked, so adding another custom tool later can't satisfy this probe by accident.
      if (toolUses.some((t: any) => t.name === READ_FILE_TOOL.name)) sawCustomTool = true;
      messages.push({ role: 'assistant', content: response.content });
      messages.push({
        role: 'user',
        content: toolUses.map((t: any) => ({
          type: 'tool_result',
          tool_use_id: t.id,
          content: FILE_SENTINEL,
        })),
      });
    }
  } catch (err: any) {
    record({ target: target.name, model, probe: 'P5 both tool kinds drive one answer', blocking: true, status: 'FAIL', detail: `failed mid-turn: ${errText(err)}` });
    return;
  }

  const ok = sawServerTool && sawCustomTool && finalAnswer.includes(FILE_SENTINEL);
  record({
    target: target.name,
    model,
    probe: 'P5 both tool kinds drive one answer',
    blocking: true,
    status: ok ? 'PASS' : 'FAIL',
    detail:
      `web_search_tool_result=${sawServerTool}, custom tool_use=${sawCustomTool}, ` +
      `pause_turn hops=${pauseTurns}, web_search_requests=${searchRequests}, ` +
      `sentinel_in_answer=${finalAnswer.includes(FILE_SENTINEL)}, shapes=${shapes.join(' | ')}`,
  });
}

// ---------------------------------------------------------------------------
// Probe 6 (informational): tool_choice support, and whether an is_error tool_result
// degrades gracefully (§6 asks for graceful degradation on rate limits).
// Neither is required by the design; we only want to know.
// ---------------------------------------------------------------------------
async function probeOptionalSurface(target: Target, model: string) {
  try {
    const forced: any = await create('probe6-tool_choice', target, model, {
      tools: [READ_FILE_TOOL],
      tool_choice: { type: 'tool', name: 'read_file' },
      messages: [{ role: 'user', content: 'Tell me about our repo.' }],
    });
    const forcedCall = blocksOf(forced, 'tool_use')[0];
    record({
      target: target.name,
      model,
      probe: 'P6a tool_choice: {type:"tool"}',
      blocking: false,
      status: 'INFO',
      detail: forcedCall
        ? `accepted and honored (called ${forcedCall.name})`
        : `accepted but not honored. stop_reason=${forced.stop_reason}, content=${shapeOf(forced)}`,
    });
  } catch (err: any) {
    record({ target: target.name, model, probe: 'P6a tool_choice: {type:"tool"}', blocking: false, status: 'INFO', detail: `rejected: ${errText(err)}` });
  }

  const question = 'Read config/release.ts and summarize it.';
  try {
    const first: any = await create('probe6-err-setup', target, model, {
      tools: [READ_FILE_TOOL],
      messages: [{ role: 'user', content: question }],
    });
    const call = blocksOf(first, 'tool_use')[0];
    if (!call) {
      record({ target: target.name, model, probe: 'P6b is_error tool_result', blocking: false, status: 'INFO', detail: 'no tool_use to answer with an error; skipped' });
      return;
    }
    const second: any = await create('probe6-err-result', target, model, {
      tools: [READ_FILE_TOOL],
      messages: [
        { role: 'user', content: question },
        { role: 'assistant', content: first.content },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: call.id,
              is_error: true,
              content: 'Rate limited by GitHub. Try again later.',
            },
          ],
        },
      ],
    });
    const answer = extractReplyText(second.content);
    record({
      target: target.name,
      model,
      probe: 'P6b is_error tool_result',
      blocking: false,
      status: 'INFO',
      detail: `accepted. stop_reason=${second.stop_reason}, answer="${answer.slice(0, 160)}"`,
    });
  } catch (err: any) {
    record({ target: target.name, model, probe: 'P6b is_error tool_result', blocking: false, status: 'INFO', detail: `rejected: ${errText(err)}` });
  }
}

async function main() {
  console.log('--- CUSTOM-TOOL PROBE (issue #21, Step 0 gate) ---');

  const { targets, skipped } = buildTargets();
  for (const s of skipped) console.log(`⏭️  Skipping ${s}`);
  if (targets.length === 0) {
    console.error('Error: no probe target has credentials. Set DEEPSEEK_API_KEY and/or ANTHROPIC_API_KEY.');
    process.exit(1);
  }
  for (const t of targets) {
    console.log(`Target ${t.name}: ${t.client.baseURL} — models ${t.models.join(', ')}`);
  }

  for (const target of targets) {
    for (const model of target.models) {
      console.log(`\n===== ${target.name} / ${model} =====`);
      const roundTrip = await probeRoundTrip(target, model);
      if (roundTrip === 'unreachable') {
        // Credentials were rejected; the remaining probes would only repeat the 401.
        for (const probe of [
          'P3 multi-step custom tool loop',
          'P4 web_search + custom tools in one request',
          'P5 both tool kinds drive one answer',
        ]) {
          record({ target: target.name, model, probe, blocking: true, status: 'SKIP', detail: 'skipped (credentials rejected)' });
        }
        continue;
      }

      await probeMultiStepLoop(target, model);
      const mixedAccepted = await probeMixedToolsAccepted(target, model);
      if (mixedAccepted) {
        await probeMixedToolsInOneTurn(target, model);
      } else {
        record({ target: target.name, model, probe: 'P5 both tool kinds drive one answer', blocking: true, status: 'FAIL', detail: 'skipped (P4 rejected the mixed tools array)' });
      }
      await probeOptionalSurface(target, model);
    }
  }

  if (dumpPath) {
    fs.writeFileSync(dumpPath, JSON.stringify(transcript, null, 2));
    console.log(`\nRaw request/response transcript written to ${dumpPath}`);
  }

  console.log('\n--- SUMMARY ---');
  for (const o of outcomes) {
    console.log(`${o.status.padEnd(4)} ${o.blocking ? '(gate)' : '(info)'} [${o.target}/${o.model}] ${o.probe}`);
  }

  const failures = outcomes.filter((o) => o.blocking && o.status === 'FAIL');
  const skips = outcomes.filter((o) => o.blocking && o.status === 'SKIP');
  const proven = [...new Set(outcomes.filter((o) => o.status === 'PASS').map((o) => `${o.target}/${o.model}`))];

  if (failures.length > 0) {
    console.error(`\n❌ GATE FAILED: ${failures.length} blocking probe(s) failed.`);
    console.error('Per issue #21 Step 0, stop and revisit the design before building the repo tools.');
    process.exit(1);
  }

  // Everything we were asked about but could not reach: credentials rejected mid-run,
  // plus targets dropped up front for a missing key.
  const unproven = [...new Set(skips.map((o) => `${o.target}/${o.model}`)), ...skipped];

  // An unreachable target proves nothing. Never report a pass we did not earn.
  if (proven.length === 0) {
    console.error('\n❌ GATE NOT RUN: no target was reached, so nothing is proven.');
    if (unproven.length > 0) console.error(`   Unproven: ${unproven.join(', ')}`);
    console.error('Set DEEPSEEK_API_KEY and/or ANTHROPIC_API_KEY to working keys and re-run.');
    process.exit(2);
  }

  console.log(`\n🎉 GATE PASSED for: ${proven.join(', ')}`);
  if (unproven.length > 0) {
    console.log(`⚠️  NOT PROVEN: ${unproven.join(', ')}`);
    if (process.env.PROBE_REQUIRE_ALL === '1') {
      console.error('\n❌ PROBE_REQUIRE_ALL=1 and not every requested target was proven.');
      process.exit(3);
    }
  }
}

main().catch((err) => {
  console.error('Probe crashed:', err);
  process.exit(1);
});
