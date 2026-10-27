// Pure helper for the <document> tags buildContext puts in the system prompt.

/**
 * Makes a document's display name safe to place inside a double-quoted XML attribute. The name is
 * typed by an editor (or comes from a file name); without this, a `"` ends the attribute early and
 * the rest of the name can forge further attributes such as scope="entity". `&` is escaped first so
 * that the escapes themselves are never re-escaped. Names without these characters are unchanged.
 */
export function escapeDocAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
