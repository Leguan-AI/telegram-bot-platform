// Unit tests for /push file-attachment helpers. Pure; no database access.
// Run: npx tsx --test scripts/test-push-file.ts
import { test } from 'node:test';
import assert from 'assert';
import { isPushableTextFile, decodePushedFile, PushFileError } from '../lib/pushFile';

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

test('accepts .txt/.md/.markdown by extension, any mime', () => {
  for (const file_name of ['a.txt', 'Notes.MD', 'readme.markdown']) {
    assert.strictEqual(isPushableTextFile({ file_name, mime_type: 'application/octet-stream' }), true);
  }
});

test('accepts text mime types without a usable extension', () => {
  assert.strictEqual(isPushableTextFile({ mime_type: 'text/plain' }), true);
  assert.strictEqual(isPushableTextFile({ file_name: 'x', mime_type: 'text/markdown' }), true);
});

test('rejects other files', () => {
  assert.strictEqual(isPushableTextFile({ file_name: 'a.pdf', mime_type: 'application/pdf' }), false);
  assert.strictEqual(isPushableTextFile({ file_name: 'a.txt.exe', mime_type: 'application/octet-stream' }), false);
  assert.strictEqual(isPushableTextFile({}), false);
});

test('decodes utf-8, strips BOM and surrounding whitespace', () => {
  assert.strictEqual(decodePushedFile(b64('﻿  # Title\n\nwe’re here\n\n')), '# Title\n\nwe’re here');
});

test('rejects binary and empty content', () => {
  assert.throws(() => decodePushedFile(b64(Buffer.from([0xff, 0xfe, 0x00, 0x81]))), (e: unknown) => e instanceof PushFileError && e.reason === 'not_text');
  assert.throws(() => decodePushedFile(b64('ab\0cd')), (e: unknown) => e instanceof PushFileError && e.reason === 'not_text');
  assert.throws(() => decodePushedFile(b64('  \n ')), (e: unknown) => e instanceof PushFileError && e.reason === 'empty');
});
