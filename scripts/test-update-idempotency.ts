// Regression harness: a Telegram retry or an edit must never run the answer again
// (#21 §7, acceptance criteria "Logging, privacy, UX").
//
// Run: npx tsx --env-file=.env.local scripts/test-update-idempotency.ts
//
// Not a unit test, and not in CI: it drives the real webhook route against the real
// database, because the guarantee lives in a unique constraint (processed_updates) and in
// the order of the route's early returns. A mock of either would be testing the mock.
//
// Why this exists at all: Telegram retries a webhook it considers failed, and an answer
// costs money and posts a message. "We already did this one" has to be decided before any
// of that, and the tool loop makes the cost of getting it wrong much higher than it was.

const originalFetch = global.fetch;
let mockResponses: Record<string, unknown> = {};
let fetchCalls: { url: string; body: any }[] = [];

global.fetch = (async (url: any, options: any) => {
  const urlStr = url.toString();
  let body: any = null;
  try {
    body = options?.body ? JSON.parse(options.body) : null;
  } catch {
    /* not JSON; the body is not what these assertions look at */
  }
  fetchCalls.push({ url: urlStr, body });

  for (const key of Object.keys(mockResponses)) {
    if (urlStr.includes(key)) {
      return new Response(JSON.stringify(mockResponses[key]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
  }
  return new Response(JSON.stringify({ ok: true, result: {} }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

import assert from 'assert';
import postgres from 'postgres';
import { NextRequest } from 'next/server';

process.env.APP_HMAC_PEPPER = process.env.APP_HMAC_PEPPER || 'dummy-test-pepper-high-entropy-random-string';

// Fixtures, distinct from every other harness in scripts/.
const USER_A = 'f7a00000-0000-0000-0000-0000000000a1';
const E1 = 'f7b00000-0000-0000-0000-0000000000e1';
const GROUP_A = 'f7c00000-0000-0000-0000-0000000000c1';
const BOT_A = 'f7d00000-0000-0000-0000-0000000000d1';
const CHAT_ID = 77400001;
const BOT_USERNAME = 'idempotency_test_bot';
const BOT_TOKEN = 'dummy-bot-token-idempotency';
const WEBHOOK_SECRET = 'super-secret-idempotency-webhook';
const TOKEN_SECRET_NAME = 'bot_idempotency_token';
const WEBHOOK_SECRET_NAME = 'bot_idempotency_webhook';

const ANSWER = 'The answer, computed exactly once.';

function modelReply(text: string) {
  return {
    id: 'msg_test',
    model: 'claude-sonnet-5',
    role: 'assistant',
    type: 'message',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

/** How many times a model was asked to produce an answer. */
const modelCalls = () => fetchCalls.filter((c) => c.url.includes('/v1/messages')).length;

/** The answers actually posted to the chat (the status message is an edit, not a send). */
const answersSent = () =>
  fetchCalls.filter((c) => c.url.includes('editMessageText') && c.body?.text === ANSWER).length;

async function post(POST: any, payload: Record<string, unknown>) {
  const request = new NextRequest(`http://localhost:3000/api/webhooks/platform/${BOT_USERNAME}`, {
    method: 'POST',
    headers: {
      'x-telegram-bot-api-secret-token': WEBHOOK_SECRET,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const response = await POST(request, { params: Promise.resolve({ botSlug: BOT_USERNAME }) });
  // The route answers in the background (waitUntil), so give that work time to finish.
  await new Promise((r) => setTimeout(r, 3500));
  return response;
}

function question(updateId: number, messageId: number) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      chat: { id: CHAT_ID, type: 'supergroup', is_forum: true },
      from: { id: 4242, first_name: 'Dana', username: 'dana' },
      date: 1700000000,
      text: `@${BOT_USERNAME} what does this project do?`,
    },
  };
}

async function main() {
  console.log('--- Telegram retry / edit idempotency ---');

  const adminUrl = process.env.ADMIN_DATABASE_URL;
  if (!adminUrl) throw new Error('ADMIN_DATABASE_URL is required to run this harness.');
  const sql = postgres(adminUrl, { prepare: false });

  const routeMod = await import('../app/api/webhooks/platform/[botSlug]/route.js');
  const POST = routeMod.POST;

  try {
    await cleanup(sql);

    const tokenRef = (await sql<{ id: string }[]>`
      select vault.create_secret(${BOT_TOKEN}, ${TOKEN_SECRET_NAME}) as id
    `)[0].id;
    const secretRef = (await sql<{ id: string }[]>`
      select vault.create_secret(${WEBHOOK_SECRET}, ${WEBHOOK_SECRET_NAME}) as id
    `)[0].id;

    await sql`insert into auth.users (id, email) values (${USER_A}, 'idempotency@test.com')`;
    await sql`
      insert into public.entities (id, slug, display_name, owner_profile_id, telegram_bot_username)
      values (${E1}, 'idempotency-test', 'Idempotency Entity', ${USER_A}, ${BOT_USERNAME})
    `;
    await sql`
      insert into public.groups (id, entity_id, telegram_chat_id, display_name)
      values (${GROUP_A}, ${E1}, ${CHAT_ID.toString()}, 'Idempotency Group')
    `;
    await sql`
      insert into public.bots (id, name, slug, telegram_username, token_secret_ref, webhook_secret_ref, status, model)
      values (${BOT_A}, 'Idempotency Bot', ${BOT_USERNAME}, ${BOT_USERNAME}, ${tokenRef}, ${secretRef}, 'active', 'claude-sonnet-5')
    `;
    await sql`insert into public.bot_entities (bot_id, entity_id) values (${BOT_A}, ${E1})`;

    console.log('Fixtures seeded.\n');

    // =====================================================================
    // Test 1: the same update twice — the retry Telegram actually makes
    // =====================================================================
    console.log('Test 1: a retried update is answered once...');
    fetchCalls = [];
    mockResponses = {
      '/v1/messages': modelReply(ANSWER),
      sendMessage: { ok: true, result: { message_id: 9001 } },
    };

    const first = await post(POST, question(60001, 70001));
    assert.strictEqual(first.status, 200, 'Test 1: the first delivery should be accepted');
    assert.strictEqual(modelCalls(), 1, 'Test 1: the first delivery should produce exactly one model call');
    assert.strictEqual(answersSent(), 1, 'Test 1: the answer should be delivered once');

    const callsAfterFirst = fetchCalls.length;
    const second = await post(POST, question(60001, 70001));
    const secondBody = await second.json();

    assert.strictEqual(second.status, 200, 'Test 1: a duplicate is still a 200 — Telegram must stop retrying');
    assert.match(secondBody.msg, /duplicate/i, `Test 1: unexpected reply ${JSON.stringify(secondBody)}`);
    assert.strictEqual(modelCalls(), 1, 'Test 1: the retry must not run the answer again');
    assert.strictEqual(answersSent(), 1, 'Test 1: the retry must not post a second answer');
    assert.strictEqual(fetchCalls.length, callsAfterFirst, 'Test 1: the retry should make no outbound calls at all');

    const ledger = await sql<{ c: string }[]>`
      select count(*) as c from public.model_calls where entity_id = ${E1}::uuid
    `;
    assert.strictEqual(ledger[0].c, '1', 'Test 1: one answer, one ledger row');
    console.log('✅ Test 1 Passed.\n');

    // =====================================================================
    // Test 2: an edit syncs the log and never reaches the answer path
    // =====================================================================
    console.log('Test 2: an edited message is not a new question...');
    fetchCalls = [];

    const edited = await post(POST, {
      update_id: 60002,
      edited_message: {
        message_id: 70001,
        chat: { id: CHAT_ID, type: 'supergroup', is_forum: true },
        from: { id: 4242, first_name: 'Dana', username: 'dana' },
        date: 1700000100,
        text: `@${BOT_USERNAME} what does this project do, really?`,
      },
    });
    const editedBody = await edited.json();

    assert.strictEqual(edited.status, 200);
    assert.match(editedBody.msg, /edit/i, `Test 2: unexpected reply ${JSON.stringify(editedBody)}`);
    assert.strictEqual(modelCalls(), 0, 'Test 2: editing a question must not ask the model again');
    assert.strictEqual(answersSent(), 0, 'Test 2: and must not post an answer');

    const logged = await sql<{ message_text: string }[]>`
      select message_text from public.message_log
      where group_id = ${GROUP_A}::uuid and telegram_message_id = 70001
    `;
    assert.match(logged[0]?.message_text ?? '', /really/, 'Test 2: the edit should still reach the log');
    console.log('✅ Test 2 Passed.\n');

    // =====================================================================
    // Test 3: the guard is not over-broad
    // =====================================================================
    console.log('Test 3: a genuinely new update is still answered...');
    fetchCalls = [];
    mockResponses = {
      '/v1/messages': modelReply(ANSWER),
      sendMessage: { ok: true, result: { message_id: 9002 } },
    };

    await post(POST, question(60003, 70003));
    assert.strictEqual(modelCalls(), 1, 'Test 3: a new update_id must still be answered');

    const processed = await sql<{ update_id: string }[]>`
      select update_id::text from public.processed_updates
      where entity_id = ${E1}::uuid order by update_id
    `;
    assert.deepStrictEqual(
      processed.map((r) => r.update_id),
      ['60001', '60003'],
      'Test 3: one row per distinct update; the edit is not an answerable update'
    );
    console.log('✅ Test 3 Passed.\n');

    console.log('🎉 ALL IDEMPOTENCY TESTS PASSED 🎉');
  } catch (error) {
    console.error('\n❌ Verification failed:');
    console.error(error);
    process.exitCode = 1;
  } finally {
    global.fetch = originalFetch;
    try {
      await cleanup(sql);
    } catch (err) {
      console.warn('Cleanup failed:', err);
    }
    await sql.end();
  }
}

/** Fixture-scoped teardown (AGENTS.md rule 4): never an unscoped delete. */
async function cleanup(sql: postgres.Sql) {
  await sql`delete from public.processed_updates where entity_id = ${E1}::uuid`;
  await sql`delete from public.model_calls where entity_id = ${E1}::uuid`;
  await sql`delete from public.message_log where group_id = ${GROUP_A}::uuid`;
  await sql`delete from public.threads where group_id = ${GROUP_A}::uuid`;
  await sql`delete from public.telegram_events where bot_slug = ${BOT_USERNAME}`;
  await sql`delete from public.bot_entities where bot_id = ${BOT_A}::uuid`;
  await sql`delete from public.bots where id = ${BOT_A}::uuid`;
  await sql`delete from public.groups where id = ${GROUP_A}::uuid`;
  await sql`delete from public.entities where id = ${E1}::uuid`;
  await sql`delete from auth.users where id = ${USER_A}::uuid`;
  await sql`delete from vault.secrets where name in (${TOKEN_SECRET_NAME}, ${WEBHOOK_SECRET_NAME})`;
}

main();
