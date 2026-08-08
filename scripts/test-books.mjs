import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { strToU8, zipSync } from 'fflate';
import { createBookService, parseBookBuffer } from '../server/books.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'duetto-books-'));
const db = new DatabaseSync(path.join(tmp, 'books-test.db'));
const emittedEvents = [];
const service = createBookService({
  db,
  dataDir: tmp,
  assertPublicUrl: async () => {},
  fetchCapped: async () => { throw new Error('not used'); },
  emitEvent: event => emittedEvents.push(event),
});

const app = express();
app.use(express.json({ limit: '2mb' }));
service.register(app);
const server = await new Promise(resolve => {
  const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}/api`;

try {
  const txt = Buffer.from('测试共读书\n作者：Duetto\n\n第一章 初见\n\n这是第一段正文。我们在同一个房间里读它。\n\n这是第二段正文，适合划线和批注。', 'utf8');
  const imported = await fetch(base + '/books/import?name=' + encodeURIComponent('测试共读书.txt') + '&format=txt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: txt,
  }).then(r => r.json());
  assert.equal(imported.ok, true);
  assert.equal(imported.book.title, '测试共读书');
  assert.ok(imported.book.block_count >= 3);

  const shelf = await fetch(base + '/books').then(r => r.json());
  assert.equal(shelf.books.length, 1);

  const detail = await fetch(base + '/book?id=' + imported.book.id).then(r => r.json());
  assert.equal(detail.ok, true);
  assert.ok(detail.chapters.length >= 1);

  const page = await fetch(base + '/book/blocks?id=' + imported.book.id + '&from=0&to=50').then(r => r.json());
  const target = page.blocks.find(b => b.text.includes('第二段正文'));
  assert.ok(target);

  const progress = await fetch(base + '/book-progress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: imported.book.id, who: 'eve', block_idx: target.idx, ts: Date.now() }),
  }).then(r => r.json());
  assert.equal(progress.ok, true);
  assert.equal(progress.progress.block_idx, target.idx);

  const passage = '第二段正文';
  const note = await fetch(base + '/book-note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: imported.book.id, block_idx: target.idx, sel_start: target.text.indexOf(passage),
      sel_end: target.text.indexOf(passage) + passage.length, passage, author: 'eve', text: '这句留给我们。',
    }),
  }).then(r => r.json());
  assert.equal(note.ok, true);

  const reply = await fetch(base + '/book-note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: imported.book.id, block_idx: target.idx, author: 'yu', text: '我也在这一页。', parent_id: note.note.id }),
  }).then(r => r.json());
  assert.equal(reply.ok, true);
  assert.equal(emittedEvents.length, 2);
  assert.equal(emittedEvents[0].type, 'com.duetto.book.note.created.v1');
  assert.equal(emittedEvents[0].data.actor, 'user');
  assert.equal(emittedEvents[1].data.actor, 'ai');
  assert.equal(emittedEvents[0].data.book.title, '测试共读书');

  const nr = service.enrichReading({ id: imported.book.id, block_idx: target.idx, quote: passage });
  assert.equal(nr.title, '测试共读书');
  assert.ok(nr.window.includes('第二段正文'));
  assert.equal(nr.notes.length, 2);

  const epub = zipSync({
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'),
    'OEBPS/content.opf': strToU8('<?xml version="1.0"?><package><metadata><dc:title>EPUB 测试书</dc:title><dc:creator>Duetto</dc:creator><dc:language>zh</dc:language></metadata><manifest><item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>'),
    'OEBPS/chapter1.xhtml': strToU8('<html><body><h1>第一章</h1><p>第一段保留边界。</p><p>第二段也有自己的稳定锚点。</p></body></html>'),
  });
  const parsedEpub = parseBookBuffer(Buffer.from(epub), { name: 'sample.epub', format: 'epub' });
  assert.equal(parsedEpub.title, 'EPUB 测试书');
  assert.equal(parsedEpub.chapters.length, 1);
  assert.ok(parsedEpub.blocks.length >= 3);
  assert.equal(parsedEpub.blocks[0].kind, 'head');

  console.log('book import, progress, notes and EPUB tests passed');
} finally {
  await new Promise(resolve => server.close(resolve));
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
