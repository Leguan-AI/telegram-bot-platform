// Unit tests for the unlinked-group setup help copy. Pure; no database access.
// Run: npx tsx --test scripts/test-setup-help.ts
import { test } from 'node:test';
import assert from 'assert';
import { buildLinkedHelp, getUnlinkedHelp, UNLINKED_NUDGE } from '../lib/setupHelp';

test('links the dashboard from the configured app URL, tolerating a trailing slash', () => {
  for (const url of ['https://app.leguan.ai', 'https://app.leguan.ai/']) {
    const html = getUnlinkedHelp(url);
    assert.ok(html.includes('<a href="https://app.leguan.ai/manage">app.leguan.ai/manage</a>'), html);
  }
});

test('covers every setup step and escapes the /auth placeholder', () => {
  const html = getUnlinkedHelp('https://app.leguan.ai');
  assert.ok(html.includes('Topics'));
  assert.ok(html.includes('Generate Link Command'));
  assert.ok(html.includes('10 minutes'));
  assert.ok(html.includes('<code>/auth &lt;code&gt;</code>'));
  assert.ok(!/<code>\/auth <code>/.test(html));
});

test('nudge points at /help', () => {
  assert.ok(UNLINKED_NUDGE.includes('/help'));
});

test('a quote in the app URL cannot break out of the href attribute', () => {
  const html = getUnlinkedHelp('https://app.leguan.ai/"onclick="x');
  assert.ok(html.includes('href="https://app.leguan.ai/&quot;onclick=&quot;x/manage"'), html);
  assert.ok(/<a href="[^"]*">/.test(html), 'href must be a single well-formed attribute');
});

// ---------------------------------------------------------------------------
// The linked-group help, whose Repositories section is a disclosure (#21 §8, §9)
// ---------------------------------------------------------------------------

test('the command list offers pinning, not only the section below it', () => {
  const html = buildLinkedHelp('leguan_the_bot');
  const commandLine = html.split('\n').find((line) => line.includes('<code>/repos</code>'))!;

  // The section further down explained pins, and a reader still came away thinking they
  // were not offered: the command list is the part people read. It carries the command
  // itself, not just the capability — `/repo pin` is a plausible guess and wrong.
  assert.ok(commandLine.includes('<code>/repos pin &lt;repo&gt;</code>'), commandLine);
  assert.ok(/group admins/i.test(commandLine), 'and says who may use it');
});

test('the Repositories section covers every point §9 requires', () => {
  const html = buildLinkedHelp('leguan_the_bot');

  const required: Array<[string, RegExp]> = [
    ['what the bot can read', /repositories an admin has linked to this group/i],
    ['read-only', /never write code/i],
    ['group members get the access', /any member can get its contents/i],
    ['sensitive files are unavailable', /never available to me/i],
    ['and are not denied', /rather than pretend they don't exist/i],
    ['/repos and topic pins', /\/repos pin/],
    ['pins only narrow', /only narrow, never widen/i],
    ['the provider disclosure', /third-party AI model providers/i],
    ['the providers by name', /Anthropic and DeepSeek/],
    ['how to disconnect', /Installed GitHub Apps/i],
  ];

  for (const [what, pattern] of required) {
    assert.ok(pattern.test(html), `${what}: ${pattern} not found in /help`);
  }
});

test('the bot username is escaped into the mention example', () => {
  const html = buildLinkedHelp('a&b<script>');
  assert.ok(html.includes('@a&amp;b&lt;script&gt;'), html);
  assert.ok(!html.includes('<script>'), 'no raw tag reaches the message');
});
