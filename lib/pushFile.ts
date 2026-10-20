// Helpers for `/push` with an attached plain-text file (.txt / .md). Pure; no I/O.

export const MAX_PUSH_FILE_BYTES = 256 * 1024; // 256 KB

const TEXT_EXTENSION = /\.(txt|md|markdown)$/i;
const TEXT_MIME_TYPES = new Set(['text/plain', 'text/markdown', 'text/x-markdown']);

/**
 * Whether a Telegram document looks like a .txt/.md file. Telegram clients often report
 * `application/octet-stream` for .md, so a matching extension is enough on its own.
 */
export function isPushableTextFile(doc: { file_name?: string; mime_type?: string }): boolean {
  if (doc.file_name && TEXT_EXTENSION.test(doc.file_name)) return true;
  return !!doc.mime_type && TEXT_MIME_TYPES.has(doc.mime_type.toLowerCase());
}

export type PushFileErrorReason = 'not_text' | 'empty';

export class PushFileError extends Error {
  constructor(public reason: PushFileErrorReason) {
    super(`push_file_${reason}`);
  }
}

/** Decodes base64 file bytes as strict UTF-8 text. Rejects binary and whitespace-only files. */
export function decodePushedFile(base64: string): string {
  const bytes = Buffer.from(base64, 'base64');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new PushFileError('not_text');
  }
  if (text.includes('\0')) throw new PushFileError('not_text');
  text = text.trim();
  if (!text) throw new PushFileError('empty');
  return text;
}
