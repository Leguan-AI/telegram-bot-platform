// Pure helpers for the scope a context document is read at. Browser-safe; no I/O.
//
// A document is bound to a scope by a manifest_entries row, and nothing stops the same document
// having several bindings: entity-wide and one group, or a group and one of its topics. Every query
// that joins manifest_entries to doc_cache therefore returns one row per BINDING, not one per
// document — so a multi-bound document is read twice: twice in the system prompt buildContext
// writes, twice in the `/context` listing, twice in the dashboard's size meter.

/** Scope layers, least specific first. The bot's prompt labels each document with one. */
export type DocScope = 'entity' | 'group' | 'topic';

/** Most specific wins when the same document is bound more than once. */
const SCOPE_RANK: Record<DocScope, number> = { entity: 0, group: 1, topic: 2 };

/** The scope of one manifest binding, from the columns every one of these queries selects. */
export function docScopeOf(row: { group_id: string | null; thread_id: string | null }): DocScope {
  if (row.thread_id !== null) return 'topic';
  return row.group_id !== null ? 'group' : 'entity';
}

/**
 * One row per document instead of one per binding, keeping the MOST SPECIFIC binding of each
 * (topic over group over entity) and dropping the rest. Keeping the most specific one is what makes
 * the prompt's `scope="..."` attribute true: a document bound entity-wide and to this group is
 * group context for this answer, and saying `entity` would invite the model to treat it as
 * background that applies everywhere.
 *
 * Input order is preserved — each kept row stays where its own binding sorted — so a caller's
 * `order by` still decides the prompt's layout, and the result is stable for a given scope as long
 * as the query's is. Ties (the same document bound twice at one scope, which the schema permits)
 * keep the first row.
 */
export function dedupeDocsByScope<T extends { doc_id: string }>(
  rows: readonly T[],
  scopeOf: (row: T) => DocScope
): T[] {
  const bestIndex = new Map<string, number>();
  rows.forEach((row, index) => {
    const seen = bestIndex.get(row.doc_id);
    if (seen === undefined || SCOPE_RANK[scopeOf(row)] > SCOPE_RANK[scopeOf(rows[seen])]) {
      bestIndex.set(row.doc_id, index);
    }
  });
  const keep = new Set(bestIndex.values());
  return rows.filter((_row, index) => keep.has(index));
}
