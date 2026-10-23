-- Migration: 20261023100000_model_calls_repo_tools.sql
-- Per-hop accounting for answers that use the repository tools (#21 §8).
--
-- One answer can now be several model calls. Each hop gets its own row, sharing an
-- answer_id, so cost, cache reads, thinking and repository use can be summed per answer
-- as well as per call. Without the shared id a tool-loop answer would look like several
-- unrelated questions in the ledger.
--
-- Idempotent throughout (AGENTS.md rule 5): every clause is `if not exists`.
--
-- Rollback: drop the four columns and the index. They are additive and nothing reads them
-- before this migration lands, so dropping them returns the table to its previous shape:
--   drop index if exists public.model_calls_answer_idx;
--   alter table public.model_calls
--     drop column if exists repo_tool_calls,
--     drop column if exists thinking_tokens,
--     drop column if exists answer_id,
--     drop column if exists hop_index;

alter table public.model_calls
  -- Repository tool calls made in this hop, counted like web_search_requests (§8).
  add column if not exists repo_tool_calls integer not null default 0,
  -- From usage.output_tokens_details.thinking_tokens, where the provider reports it.
  -- Nullable, because "the provider did not say" is not the same as zero.
  add column if not exists thinking_tokens integer,
  -- Shared by every hop of one answer. Not a foreign key: it names an answer, which is
  -- not a row anywhere.
  add column if not exists answer_id uuid,
  -- 0 for the first call of an answer; null for calls made outside a tool loop.
  add column if not exists hop_index integer;

-- Partial: only tool-loop answers carry an answer_id, and they are the minority.
create index if not exists model_calls_answer_idx
  on public.model_calls (answer_id)
  where answer_id is not null;
