// Browser-safe helpers for the dashboard's context editor. Pure; no I/O.
// The 256 KB cap mirrors the database check in save_managed_context and MAX_PUSH_FILE_BYTES for /push.

export const MAX_CONTEXT_BYTES = 256 * 1024;

export function contextByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export class ContextFileError extends Error {}

/** Decodes an uploaded .md/.txt file as strict UTF-8 text, enforcing the size cap. */
export function decodeContextFile(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.byteLength > MAX_CONTEXT_BYTES) {
    throw new ContextFileError(`That file is too large (max ${MAX_CONTEXT_BYTES / 1024} KB).`);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(view);
  } catch {
    throw new ContextFileError('That file is not UTF-8 text. Please upload a .md or .txt file.');
  }
  if (text.includes('\0')) {
    throw new ContextFileError('That file is not UTF-8 text. Please upload a .md or .txt file.');
  }
  if (!text.trim()) {
    throw new ContextFileError('That file is empty.');
  }
  return text;
}

/** Maps a context RPC error message to something a person can act on. */
export function contextErrorMessage(message: string | undefined | null): string {
  const m = message ?? '';
  if (m.includes('context_conflict')) {
    return 'Someone else saved a newer version while you were editing. Reload to see it (your unsaved text will be replaced).';
  }
  if (m.includes('empty_content')) return 'Context cannot be empty.';
  if (m.includes('content_too_large')) return `Context is too large (max ${MAX_CONTEXT_BYTES / 1024} KB).`;
  if (m.includes('group_not_in_entity')) return 'That group does not belong to this entity.';
  if (m.includes('Access Denied')) return 'You do not have permission to edit context here.';
  return m || 'Something went wrong.';
}
