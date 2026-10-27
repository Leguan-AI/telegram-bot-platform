// Browser-safe helpers for the dashboard's "how much context is this?" meter. Pure; no I/O.
//
// Why a budget at all: buildContext (lib/capabilities.ts) concatenates EVERY document in scope into
// the system prompt of EVERY answer, with no total cap. Each document is capped at 256 KB
// (MAX_CONTEXT_BYTES) but the number of documents is not, so a handful of large ones can push the
// prompt past the model's context window or make the first token so slow that the 100 s answer
// deadline (ANSWER_DEADLINE_MS) fires. When that happens, every answer for the entity or group
// fails, not just the one that added the last document. This is advisory UI only (PR #42, review
// S1, option (a)); nothing server-side enforces it.

/**
 * The most context we advise per answer: 400 KB, about 100K tokens at the usual ~4 bytes per token
 * for English text. That is roughly half of a 200K-token window, which leaves room for the
 * conversation, the tool results the loop appends, and the answer itself, and keeps the prompt
 * small enough that first-token latency stays well inside the 100 s deadline.
 * It is deliberately far above today's largest production entity (~96 KB) and below what four
 * maximum-size documents (4 × 256 KB) would add up to. Source: Reviewer's S1 proposal.
 */
export const CONTEXT_BUDGET_BYTES = 400 * 1024;

/**
 * Where the "getting large" warning starts: 75% of the budget (300 KB). That leaves a third of the
 * budget as headroom so an admin sees the warning while there is still room to trim, rather than
 * learning about the limit when answers start failing.
 */
export const CONTEXT_WARN_FRACTION = 0.75;
export const CONTEXT_WARN_BYTES = CONTEXT_BUDGET_BYTES * CONTEXT_WARN_FRACTION;

export type ContextBudgetLevel = 'ok' | 'warn' | 'over';

/** The slice of a listed document the budget needs. */
export interface BudgetDoc {
  doc_id: string;
  scope: 'entity' | 'group' | 'topic';
  thread_name: string | null;
  size_bytes: number;
}

export function sumDocBytes(docs: readonly { size_bytes: number }[]): number {
  return docs.reduce((total, d) => total + d.size_bytes, 0);
}

/**
 * What one answer in this scope can carry, in bytes: the inherited documents (an entity's
 * documents for a group), plus the documents of the scope itself, plus — because a question is
 * asked in one topic at a time — the documents of the single largest topic, not of all topics.
 */
export function effectiveContextBytes(
  inherited: readonly { size_bytes: number }[],
  docs: readonly BudgetDoc[]
): number {
  const topicTotals = new Map<string, number>();
  let scopeTotal = 0;
  for (const d of docs) {
    if (d.scope === 'topic') {
      const key = d.thread_name ?? '\0unnamed-topic';
      topicTotals.set(key, (topicTotals.get(key) ?? 0) + d.size_bytes);
    } else {
      scopeTotal += d.size_bytes;
    }
  }
  const largestTopic = topicTotals.size > 0 ? Math.max(...topicTotals.values()) : 0;
  return sumDocBytes(inherited) + scopeTotal + largestTopic;
}

export function contextBudgetLevel(totalBytes: number): ContextBudgetLevel {
  if (totalBytes > CONTEXT_BUDGET_BYTES) return 'over';
  if (totalBytes >= CONTEXT_WARN_BYTES) return 'warn';
  return 'ok';
}

/** Share of the budget used, clamped to 0..1 for a progress bar. */
export function contextBudgetFraction(totalBytes: number): number {
  return Math.min(1, Math.max(0, totalBytes / CONTEXT_BUDGET_BYTES));
}

export function formatContextBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** The warning to show for a total, or null when it is comfortably within budget. */
export function contextBudgetWarning(totalBytes: number): string | null {
  const level = contextBudgetLevel(totalBytes);
  const budget = formatContextBytes(CONTEXT_BUDGET_BYTES);
  if (level === 'over') {
    return (
      `This is over the recommended ${budget} of context. The bot reads all of it for every ` +
      `answer, so answers may fail or time out — for every question here, not only about the ` +
      `newest document. Remove or shorten documents.`
    );
  }
  if (level === 'warn') {
    return (
      `Getting large: close to the recommended ${budget} of context. The bot reads all of it ` +
      `for every answer, and past that point answers may fail or time out. Consider trimming ` +
      `documents before adding more.`
    );
  }
  return null;
}
