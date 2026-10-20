// Unit tests for the unlinked-group setup help copy. Pure; no database access.
// Run: npx tsx --test scripts/test-setup-help.ts
import { test } from 'node:test';
import assert from 'assert';
import { getUnlinkedHelp, UNLINKED_NUDGE } from '../lib/setupHelp';

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
