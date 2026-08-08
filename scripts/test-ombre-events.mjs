import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createOmbreEventBridge, deriveOmbreEventUrl } from '../server/ombre-events.mjs';


assert.equal(
  deriveOmbreEventUrl({ context_url: 'https://ombre.example/api/duetto/context' }),
  'https://ombre.example/api/duetto/events',
);
assert.equal(deriveOmbreEventUrl({ context_url: 'https://ombre.example/other' }), '');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'duetto-ombre-events-'));
const db = new DatabaseSync(path.join(tmp, 'events.db'));
let settings = { ai: { context_url: '', context_key: 'secret-token' } };
let captured = null;
const bridge = createOmbreEventBridge({
  db,
  getSettings: () => settings,
  assertPublicUrl: async url => assert.equal(url, 'https://ombre.example/api/duetto/events'),
  fetchT: async (url, options, timeout) => {
    captured = { url, options, timeout };
    return { ok: true, status: 200 };
  },
  source: 'urn:duetto:test',
  log: { warn: () => {} },
});

try {
  const event = bridge.queue({
    id: 'music-play:1',
    type: 'com.duetto.music.played.v1',
    subject: 'song/1',
    time: '2026-08-08T02:00:00Z',
    data: { actor: 'ai', song: { id: '1', title: '夜曲', artist: '周杰伦' } },
  });
  assert.equal(event.specversion, '1.0');
  assert.equal(bridge.pendingCount(), 1);
  await bridge.flush();

  settings = { ai: { context_url: 'https://ombre.example/api/duetto/context', context_key: 'secret-token' } };
  const result = await bridge.flush();
  assert.equal(result.delivered, 1);
  assert.equal(bridge.pendingCount(), 0);
  assert.equal(captured.options.headers.Authorization, 'Bearer secret-token');
  assert.equal(captured.options.headers['Content-Type'], 'application/cloudevents+json');
  assert.equal(JSON.parse(captured.options.body).id, 'music-play:1');
  assert.equal(captured.timeout, 70000);
  console.log('Ombre event outbox tests passed');
} finally {
  bridge.stop();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
