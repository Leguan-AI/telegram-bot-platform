#!/usr/bin/env bash
#
# Apply pending migrations to the remote database (AGENTS.md rules 7-8).
#
# Why this exists: the Supabase CLI keeps its project link in supabase/.temp, which is
# untracked, so every new git worktree starts unlinked and `supabase db push` fails with
# "Cannot find project ref". Passing --project-ref uses your `supabase login` credentials
# instead, which are global — no link, no database password, no .env.local.
#
# What the guards are for (AGENTS.md rule 8, as amended on 2026-10-22): a push must be a
# deliberate act, never a side effect of something else. The operator at a prompt qualifies,
# and so does an agent the operator has asked to push — which it signals by setting
# ALLOW_NONINTERACTIVE_DB_PUSH=1. CI never qualifies, and neither does a test harness or a
# workflow, none of which has any reason to set that variable.
#
# Override the project with SUPABASE_PROJECT_REF=... (e.g. a Supabase branch).

set -euo pipefail

PROJECT_REF="${SUPABASE_PROJECT_REF:-eomnjhbjrkfcpzzbcdho}"

if [ -n "${CI:-}" ]; then
  echo "db:push refuses to run in CI: migrations never reach the ledger from a workflow (AGENTS.md rule 8)." >&2
  exit 1
fi

if [ ! -t 0 ] && [ "${ALLOW_NONINTERACTIVE_DB_PUSH:-}" != "1" ]; then
  cat >&2 <<'MSG'
db:push needs either a terminal or an explicit go-ahead.

A push must be deliberate, never a side effect (AGENTS.md rule 8). Run it yourself:

    npm run db:push

An agent pushing because the operator asked it to sets this instead:

    ALLOW_NONINTERACTIVE_DB_PUSH=1 npm run db:push

To see what is pending without applying anything:

    npm run db:status
MSG
  exit 1
fi

echo "Pushing migrations to project ${PROJECT_REF}..."
npx supabase db push --project-ref "${PROJECT_REF}"

echo
echo "Ledger after the push:"
npx supabase migration list --project-ref "${PROJECT_REF}"
