#!/usr/bin/env bash
#
# Talk to the remote Supabase database: `status` lists the migration ledger, `push`
# applies pending migrations (AGENTS.md rules 7-8).
#
#   bash scripts/db-remote.sh status
#   bash scripts/db-remote.sh push
#
# Why this exists: the CLI keeps its project link in supabase/.temp, which is untracked,
# so every new git worktree starts unlinked and a bare `supabase db push` fails with
# "Cannot find project ref". Passing --project-ref uses your `supabase login` credentials
# instead, which are global — no link, no database password, no .env.local.
#
# The target is never implied. SUPABASE_PROJECT_REF has no default, so an unset variable
# cannot silently mean production, and the production project additionally requires
# CONFIRM_PROD=1. A push always dry-runs first and prints what it would apply.
#
# AGENTS.md rule 8 holds the rest: an agent may push only a specific push the operator
# approved in their own words, having shown the dry run and stated a rollback, with a
# separate OK for anything destructive. The script cannot judge that; it only makes the
# cases it *can* check impossible to trip by accident.

set -euo pipefail

# Compared against, never defaulted to.
PRODUCTION_PROJECT_REF="eomnjhbjrkfcpzzbcdho"

MODE="${1:-}"
if [ "${MODE}" != "status" ] && [ "${MODE}" != "push" ]; then
  echo "usage: bash scripts/db-remote.sh status|push" >&2
  exit 2
fi

if [ -z "${SUPABASE_PROJECT_REF:-}" ]; then
  cat >&2 <<MSG
SUPABASE_PROJECT_REF is not set, and there is no default on purpose: an unset variable
must never mean production.

    SUPABASE_PROJECT_REF=${PRODUCTION_PROJECT_REF} npm run db:status      # production (read-only)
    SUPABASE_PROJECT_REF=<branch-ref> npm run db:push                     # a Supabase branch

Production pushes also need CONFIRM_PROD=1.
MSG
  exit 1
fi

PROJECT_REF="${SUPABASE_PROJECT_REF}"
TARGET_LABEL="${PROJECT_REF}"
if [ "${PROJECT_REF}" = "${PRODUCTION_PROJECT_REF}" ]; then
  TARGET_LABEL="${PROJECT_REF} (PRODUCTION)"
fi

if [ "${MODE}" = "status" ]; then
  echo "Migration ledger for ${TARGET_LABEL}:"
  exec npx supabase migration list --project-ref "${PROJECT_REF}"
fi

# ---- push ------------------------------------------------------------------

if [ -n "${CI:-}" ]; then
  echo "db:push refuses to run in CI: migrations never reach the ledger from a workflow (AGENTS.md rule 8)." >&2
  exit 1
fi

if [ ! -t 0 ] && [ "${ALLOW_NONINTERACTIVE_DB_PUSH:-}" != "1" ]; then
  cat >&2 <<'MSG'
db:push needs either a terminal or an explicit go-ahead.

A push must be deliberate, never a side effect (AGENTS.md rule 8). Run it yourself:

    SUPABASE_PROJECT_REF=<ref> npm run db:push

An agent pushing a specific push the operator approved sets this instead:

    ALLOW_NONINTERACTIVE_DB_PUSH=1 SUPABASE_PROJECT_REF=<ref> npm run db:push
MSG
  exit 1
fi

if [ "${PROJECT_REF}" = "${PRODUCTION_PROJECT_REF}" ] && [ "${CONFIRM_PROD:-}" != "1" ]; then
  cat >&2 <<MSG
Refusing to push to the PRODUCTION project (${PROJECT_REF}) without CONFIRM_PROD=1.

    CONFIRM_PROD=1 SUPABASE_PROJECT_REF=${PROJECT_REF} npm run db:push
MSG
  exit 1
fi

echo "=== Dry run against ${TARGET_LABEL} ==="
npx supabase db push --project-ref "${PROJECT_REF}" --dry-run

echo
echo "=== Applying to ${TARGET_LABEL} at $(date -u '+%Y-%m-%dT%H:%M:%SZ') ==="
# `db push` asks for confirmation before applying. A person at a prompt should get that
# question; a non-interactive run has nobody to answer it, and there the deliberate
# ALLOW_NONINTERACTIVE_DB_PUSH=1 above already served as the confirmation.
if [ -t 0 ]; then
  npx supabase db push --project-ref "${PROJECT_REF}"
else
  npx supabase db push --project-ref "${PROJECT_REF}" --yes
fi

echo
echo "=== Ledger after the push to ${TARGET_LABEL} ==="
npx supabase migration list --project-ref "${PROJECT_REF}"
