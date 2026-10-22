#!/usr/bin/env bash
#
# Apply pending migrations to the remote database (AGENTS.md rules 7-8).
#
# Why this exists: the Supabase CLI keeps its project link in supabase/.temp, which is
# untracked, so every new git worktree starts unlinked and `supabase db push` fails with
# "Cannot find project ref". Passing --project-ref uses your `supabase login` credentials
# instead, which are global — no link, no database password, no .env.local.
#
# Why it refuses a non-interactive shell: AGENTS.md rule 8 reserves migration pushes for
# the operator, by hand. The tty check keeps CI, a harness or an agent from running it,
# while staying out of the way of a human in a terminal.
#
# Override the project with SUPABASE_PROJECT_REF=... (e.g. a Supabase branch).

set -euo pipefail

PROJECT_REF="${SUPABASE_PROJECT_REF:-eomnjhbjrkfcpzzbcdho}"

if [ ! -t 0 ]; then
  cat >&2 <<'MSG'
db:push is an operator step and refuses to run without a terminal.

Migrations reach the remote migration ledger by hand only (AGENTS.md rule 8), so no CI
job, test harness or agent may push them. Run this yourself:

    npm run db:push

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
