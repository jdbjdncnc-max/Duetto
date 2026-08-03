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

const envSandbox = { process: { env: {} } };
vm.createContext(envSandbox);
vm.runInContext(
  `${sourceBetween('function envValue', 'function getStoredSettings')}globalThis.applyAiEnvUnderTest = applyAiEnv; globalThis.stripEnvManagedAiSecretsUnderTest = stripEnvManagedAiSecrets;`,
  envSandbox,
);
const envConfigured = {
  DUETTO_CHAT_BASE_URL: 'https://ombre.example/v1',
  DUETTO_CHAT_API_KEY: 'gateway-secret',
  DUETTO_CHAT_MODEL: 'zeta-gateway',
  DUETTO_ANALYSIS_BASE_URL: 'https://openrouter.ai/api/v1',
  DUETTO_ANALYSIS_API_KEY: 'analysis-secret',
  DUETTO_ANALYSIS_MODEL: 'google/gemini-2.5-flash',
};
const envAi = envSandbox.applyAiEnvUnderTest({ api_key: 'file-secret' }, envConfigured);
assert.equal(envAi.base_url, 'https://ombre.example/v1');
assert.equal(envAi.api_key, 'gateway-secret');
assert.equal(envAi.a_key, 'analysis-secret');
assert.equal(envAi.a_model, 'google/gemini-2.5-flash');
const persistedAi = envSandbox.stripEnvManagedAiSecretsUnderTest(envAi, envConfigured);
assert.equal(Object.hasOwn(persistedAi, 'api_key'), false);
assert.equal(Object.hasOwn(persistedAi, 'a_key'), false);
assert.equal(envAi.api_key, 'gateway-secret');

const promptSandbox = {
  fmtSec: (seconds) => String(seconds),
  timeBucket: () => '测试时段',
};
vm.createContext(promptSandbox);
vm.runInContext(
  `${sourceBetween('function sysPrompt', '// —— 在场记录')}globalThis.sysPromptUnderTest = sysPrompt;`,
  promptSandbox,
);
const scenePrompt = promptSandbox.sysPromptUnderTest(
  {
    ai_name: 'Zeta',
    user_name: 'Eve',
    ai: {
      ai_name: 'Zeta',
      user_name: 'Eve',
      persona: 'SHOULD_NOT_APPEAR_PERSONA',
      style: 'SHOULD_NOT_APPEAR_STYLE',
      time_aware: false,
    },
  },
  'music',
  { title: 'Test Song', artist: 'Test Artist' },
  '',
);
assert.equal(scenePrompt.includes('SHOULD_NOT_APPEAR_PERSONA'), false);
assert.equal(scenePrompt.includes('SHOULD_NOT_APPEAR_STYLE'), false);
assert.equal(scenePrompt.includes('<<ACT>>'), true);
assert.equal(scenePrompt.includes('Test Song'), true);

console.log('context auth tests passed');
