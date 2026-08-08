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
  URL,
  assertPublicUrl: async () => {},
  fetchT: async (url, options, timeout) => {
    capturedRequest = { url, options, timeout };
    return { ok: true, json: async () => ({ context: 'remembered context' }) };
  },
};
vm.createContext(contextSandbox);
vm.runInContext(
  `${sourceBetween('function usesOmbreRecallHandoff', 'function sysPrompt')}globalThis.fetchContextUnderTest = fetchContext;`,
  contextSandbox,
);

const context = await contextSandbox.fetchContextUnderTest(
  { ai: { base_url: 'https://ombre.example/v1', context_url: 'https://ombre.example/api/duetto/context', context_key: 'secret-token' } },
  'hello',
  { id: '1', title: 'Song', artist: 'Artist' },
);
assert.equal(context.text, 'remembered context');
assert.equal(context.recallInjected, true);
assert.equal(capturedRequest.options.headers.Authorization, 'Bearer secret-token');
assert.equal(capturedRequest.timeout, 4000);
assert.equal(JSON.parse(capturedRequest.options.body).context_mode, 'memory_only');

await contextSandbox.fetchContextUnderTest(
  { ai: { base_url: 'https://ombre.example/v1', context_url: 'https://ombre.example/api/duetto/context', context_key: 'secret-token' } },
  'book note',
  { id: 'b1', title: 'Book', author: 'Writer', chapter_title: 'Chapter One', block_idx: 8 },
  'book',
);
const bookContextBody = JSON.parse(capturedRequest.options.body);
assert.equal(bookContextBody.kind, 'book');
assert.equal(bookContextBody.song, null);
assert.equal(bookContextBody.book.title, 'Book');

const genericContext = await contextSandbox.fetchContextUnderTest(
  { ai: { base_url: 'https://openrouter.ai/api/v1', context_url: 'https://ombre.example/api/duetto/context', context_key: 'secret-token' } },
  'hello',
  { id: '1', title: 'Song', artist: 'Artist' },
);
assert.equal(genericContext.recallInjected, false);
assert.equal(Object.hasOwn(JSON.parse(capturedRequest.options.body), 'context_mode'), false);

let capturedLlmRequest = null;
const llmSandbox = {
  fetchT: async (url, options, timeout) => {
    capturedLlmRequest = { url, options, timeout };
    return {
      ok: true,
      json: async () => ({ model: 'chat-model', choices: [{ message: { content: 'ok' } }] }),
    };
  },
  normalizeUsage: () => null,
};
vm.createContext(llmSandbox);
vm.runInContext(
  `${sourceBetween('async function callLLMResult', 'async function callLLM(s')}globalThis.callLLMResultUnderTest = callLLMResult;`,
  llmSandbox,
);
await llmSandbox.callLLMResultUnderTest(
  { ai: { base_url: 'https://ombre.example/v1', api_key: 'gateway-secret', model: 'chat-model' } },
  [{ role: 'user', content: 'hello' }],
  { recallInjected: true },
);
assert.equal(capturedLlmRequest.options.headers['X-Ombre-Recall-Mode'], 'injected');

const syncSource = fs.readFileSync(path.join(root, 'frontend', 'pkg', 'sync.js'), 'utf8');
const bridgeSource = fs.readFileSync(path.join(root, 'frontend', 'pkg', 'claude-bridge.js'), 'utf8');
assert.equal(source.includes('await Promise.race([r'), false);
assert.equal(syncSource.includes("res('[对话请求超时，请重试]')"), true);
assert.equal(bridgeSource.includes('[对话模型错误:'), true);

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
  DUETTO_CONTEXT_URL: 'https://ombre.example/api/duetto/context',
  DUETTO_CONTEXT_KEY: 'context-secret',
};
const envAi = envSandbox.applyAiEnvUnderTest({ api_key: 'file-secret' }, envConfigured);
assert.equal(envAi.base_url, 'https://ombre.example/v1');
assert.equal(envAi.api_key, 'gateway-secret');
assert.equal(envAi.a_key, 'analysis-secret');
assert.equal(envAi.a_model, 'google/gemini-2.5-flash');
assert.equal(envAi.context_url, 'https://ombre.example/api/duetto/context');
assert.equal(envAi.context_key, 'context-secret');
const persistedAi = envSandbox.stripEnvManagedAiSecretsUnderTest(envAi, envConfigured);
assert.equal(Object.hasOwn(persistedAi, 'api_key'), false);
assert.equal(Object.hasOwn(persistedAi, 'a_key'), false);
assert.equal(Object.hasOwn(persistedAi, 'context_key'), false);
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
  'current solitude state',
);
assert.equal(scenePrompt.includes('SHOULD_NOT_APPEAR_PERSONA'), false);
assert.equal(scenePrompt.includes('SHOULD_NOT_APPEAR_STYLE'), false);
assert.equal(scenePrompt.includes('<<ACT>>'), true);
assert.equal(scenePrompt.includes('Test Song'), true);
assert.equal(scenePrompt.includes('Ombre 提供的当前状态与相关记忆'), true);
assert.equal(scenePrompt.includes('current solitude state'), true);

console.log('context auth tests passed');
