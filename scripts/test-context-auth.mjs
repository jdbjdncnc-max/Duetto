import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';


const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'server', 'index.mjs'), 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `cannot locate ${startMarker}`);
  return source.slice(start, end);
}

let capturedRequest = null;
const contextSandbox = {
  assertPublicUrl: async () => {},
  fetchT: async (url, options, timeout) => {
    capturedRequest = { url, options, timeout };
    return { ok: true, json: async () => ({ context: 'remembered context' }) };
  },
};
vm.createContext(contextSandbox);
vm.runInContext(
  `${sourceBetween('async function fetchContext', 'function sysPrompt')}globalThis.fetchContextUnderTest = fetchContext;`,
  contextSandbox,
);

const context = await contextSandbox.fetchContextUnderTest(
  { ai: { context_url: 'https://ombre.example/api/duetto/context', context_key: 'secret-token' } },
  'hello',
  { id: '1', title: 'Song', artist: 'Artist' },
);
assert.equal(context, 'remembered context');
assert.equal(capturedRequest.options.headers.Authorization, 'Bearer secret-token');
assert.equal(capturedRequest.timeout, 4000);

const redactSandbox = {};
vm.createContext(redactSandbox);
vm.runInContext(
  `${sourceBetween('function redactSettings', 'function writePrivate')}globalThis.redactSettingsUnderTest = redactSettings;`,
  redactSandbox,
);
const redacted = redactSandbox.redactSettingsUnderTest({
  ai: { api_key: 'chat-secret', a_key: 'audio-secret', context_key: 'context-secret' },
});
assert.equal(redacted.ai.api_key, '');
assert.equal(redacted.ai.a_key, '');
assert.equal(redacted.ai.context_key, '');
assert.equal(redacted.ai.has_context_key, true);
assert.equal(redacted.ai.context_key_hint, '****cret');

console.log('context auth tests passed');
