// Unit tests for the dashboard context editor helpers. Pure; no database access.
// Run: npx tsx --test scripts/test-context-file.ts
import { test } from 'node:test';
import assert from 'assert';
import {
  MAX_CONTEXT_BYTES,
  contextByteLength,
  decodeContextFile,
  contextErrorMessage,
  ContextFileError,
} from '../lib/contextFile';

const bytes = (s: string) => new TextEncoder().encode(s);

test('counts bytes, not characters', () => {
  assert.strictEqual(contextByteLength('abc'), 3);
  assert.strictEqual(contextByteLength('é'), 2);
  assert.strictEqual(contextByteLength('€'), 3);
});

test('decodes UTF-8 and keeps content as written', () => {
  assert.strictEqual(decodeContextFile(bytes('# Title\n\nwe’re here\n')), '# Title\n\nwe’re here\n');
});

test('rejects oversize, binary, and empty files', () => {
  assert.throws(() => decodeContextFile(new Uint8Array(MAX_CONTEXT_BYTES + 1).fill(65)), ContextFileError);
  assert.doesNotThrow(() => decodeContextFile(new Uint8Array(MAX_CONTEXT_BYTES).fill(65)));
  assert.throws(() => decodeContextFile(new Uint8Array([0xff, 0xfe, 0x81])), /not UTF-8/);
  assert.throws(() => decodeContextFile(bytes('ab\0cd')), /not UTF-8/);
  assert.throws(() => decodeContextFile(bytes('  \n ')), /empty/);
});

test('maps RPC errors to readable messages', () => {
  assert.match(contextErrorMessage('context_conflict'), /newer version/);
  assert.match(contextErrorMessage('empty_content'), /cannot be empty/);
  assert.match(contextErrorMessage('content_too_large'), /256 KB/);
  assert.match(contextErrorMessage('Access Denied'), /permission/);
  assert.strictEqual(contextErrorMessage('boom'), 'boom');
  assert.strictEqual(contextErrorMessage(null), 'Something went wrong.');
});
