// Unit tests for the one answer deadline (#21 §7, #37 review B1). Pure: no network, no
// database — but it does read the webhook route's source, to check the one number that
// cannot be imported.
// Run: npx tsx --test scripts/test-answer-budget.ts

import { test } from 'node:test';
import assert from 'assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  ANSWER_DEADLINE_MS,
  ANSWER_MAX_DURATION_SECONDS,
  FINALISE_RESERVE_MS,
  GITHUB_CALL_TIMEOUT_MS,
  TELEGRAM_CALL_TIMEOUT_MS,
  deadlineAt,
  startAnswerDeadline,
} from '../lib/answerBudget';

const ROUTE = path.join(__dirname, '../app/api/webhooks/platform/[botSlug]/route.ts');

test("the route's maxDuration matches what the budget is sized for", () => {
  // Next requires route segment config to be statically analysable, so the route cannot
  // import this value — which means the two can drift, and the drift is invisible until
  // a function is killed in production. Hence reading the file.
  const source = readFileSync(ROUTE, 'utf8');
  const match = source.match(/^export const maxDuration = (\d+);?\s*$/m);

  assert.ok(match, 'the route should declare maxDuration on its own line');
  assert.strictEqual(
    Number(match![1]),
    ANSWER_MAX_DURATION_SECONDS,
    'lib/answerBudget.ts and the route disagree about how long an answer may take'
  );
});

test('the deadline and the final call fit inside the route limit, with room to send', () => {
  const limitMs = ANSWER_MAX_DURATION_SECONDS * 1000;
  const worstCase = ANSWER_DEADLINE_MS + FINALISE_RESERVE_MS;

  assert.ok(worstCase < limitMs, `${worstCase}ms of work against a ${limitMs}ms limit`);

  // What is left has to cover the ledger writes and the Telegram send — the steps that
  // turn the work into something the user can actually see.
  const margin = limitMs - worstCase;
  assert.ok(
    margin >= TELEGRAM_CALL_TIMEOUT_MS + 5000,
    `only ${margin}ms left to log and send the answer`
  );
});

test('one GitHub call cannot consume the whole deadline', () => {
  assert.ok(GITHUB_CALL_TIMEOUT_MS * 2 < FINALISE_RESERVE_MS + ANSWER_DEADLINE_MS);
  assert.ok(GITHUB_CALL_TIMEOUT_MS < FINALISE_RESERVE_MS, 'a read must not outlast the reserve');
});

test('remaining time counts down and then expires', () => {
  let clock = 1_000;
  const deadline = deadlineAt(10_000, () => clock);

  assert.strictEqual(deadline.at, 10_000);
  assert.strictEqual(deadline.remainingMs(), 9_000);
  assert.strictEqual(deadline.expired(), false);

  clock = 10_000;
  assert.strictEqual(deadline.remainingMs(), 0);
  assert.strictEqual(deadline.expired(), true, 'expired at the instant itself, not after it');

  clock = 12_000;
  assert.strictEqual(deadline.remainingMs(), -2_000, 'and keeps counting past it');
});

test('a signal takes the shorter of the call timeout and what is left', async () => {
  let clock = 0;
  // 50ms left, a 10s call timeout: the deadline wins.
  const tight = deadlineAt(50, () => clock);
  const signal = tight.signal(GITHUB_CALL_TIMEOUT_MS);

  assert.strictEqual(signal.aborted, false, 'it has not fired yet');
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.strictEqual(signal.aborted, true, 'it fired at the deadline, not 10s later');
});

test('a signal never arrives already fired', () => {
  // Past the deadline, the request still gets a moment: a signal that has already fired
  // turns "we are out of time" into "the call failed", which reads as a GitHub fault.
  const past = deadlineAt(0, () => 5_000);
  assert.strictEqual(past.signal(GITHUB_CALL_TIMEOUT_MS).aborted, false);
});

test('the answer deadline starts from now', () => {
  const deadline = startAnswerDeadline(() => 1_000);
  assert.strictEqual(deadline.at, 1_000 + ANSWER_DEADLINE_MS);
});
