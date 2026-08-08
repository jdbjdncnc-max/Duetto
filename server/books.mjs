import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { unzipSync, strFromU8 } from 'fflate';

const MAX_BOOK_BYTES = 50 * 1024 * 1024;
const MAX_BLOCKS_PAGE = 200;
const WHO_KEYS = new Set(['eve', 'yu', 'shared']);
let ftsReady = false;

function textValue(value, limit = 1000) {
  return String(value == null ? '' : value).replace(/\u0000/g, '').trim().slice(0, limit);
}

function decodeEntities(value) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  };
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => Object.prototype.hasOwnProperty.call(named, n.toLowerCase()) ? named[n.toLowerCase()] : m);
}

function plainHtml(value) {
  return decodeEntities(String(value || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|svg|math)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

function htmlSegments(html) {
  let source = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|svg|math)\b[\s\S]*?<\/\1>/gi, '');
  source = source.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, _n, inner) => `\n\n\u0001HEAD\u0001${plainHtml(inner)}\u0001END\u0001\n\n`);
  source = source.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner) => `\n\n\u0001QUOTE\u0001${plainHtml(inner)}\u0001END\u0001\n\n`);
  source = source
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|pre|section|article|aside|dd|dt|tr)>/gi, '\n\n')
    .replace(/<(p|div|li|pre|section|article|aside|dd|dt|tr)\b[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ');
  source = decodeEntities(source)
    .replace(/\r/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n');
  return source.split(/\n{2,}/).map(part => {
    let kind = 'para';
    let text = part.trim();
    if (text.startsWith('\u0001HEAD\u0001')) {
      kind = 'head';
      text = text.slice(6).replace(/\u0001END\u0001/g, '').trim();
    } else if (text.startsWith('\u0001QUOTE\u0001')) {
      kind = 'quote';
      text = text.slice(7).replace(/\u0001END\u0001/g, '').trim();
    }
    return { kind, text: text.replace(/\u0001(?:HEAD|QUOTE|END)\u0001/g, '').trim() };
  }).filter(x => x.text);
}

function splitLongParagraph(text, max = 520) {
  const value = String(text || '').trim();
  if (value.length <= max) return value ? [value] : [];
  const out = [];
  let rest = value;
  while (rest.length > max) {
    const floor = Math.floor(max * 0.58);
    const sample = rest.slice(0, max + 1);
    let cut = -1;
    for (const re of [/[。！？!?；;]\s*/g, /[，,、]\s*/g, /\s+/g]) {
      let m;
      while ((m = re.exec(sample))) {
        const at = m.index + m[0].length;
        if (at >= floor) cut = at;
      }
      if (cut >= floor) break;
    }
    if (cut < floor) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

function normalizeSegments(segments) {
  const blocks = [];
  for (const part of segments || []) {
    const kind = part && part.kind === 'head' ? 'head' : part && part.kind === 'quote' ? 'quote' : 'para';
    const value = String(part && part.text || '').replace(/\s+/g, ' ').trim();
    if (!value) continue;
    const pieces = kind === 'head' ? [value.slice(0, 400)] : splitLongParagraph(value);
    for (const piece of pieces) blocks.push({ kind, text: piece });
  }
  return blocks;
}

function isChapterTitle(value) {
  const s = String(value || '').trim();
  if (!s || s.length > 80) return false;
  return /^(?:第[〇零一二三四五六七八九十百千万两\d]+[章回节卷部篇]|卷[〇零一二三四五六七八九十百千万两\d]+|Chapter\s+\d+|CHAPTER\s+[IVXLCDM\d]+|序章|楔子|引子|前言|序言|后记|尾声|终章|附录)/i.test(s);
}

function decodeTxt(buf) {
  const bytes = new Uint8Array(buf);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.slice(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = bytes.slice(2);
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const t = swapped[i]; swapped[i] = swapped[i + 1]; swapped[i + 1] = t;
    }
    return new TextDecoder('utf-16le').decode(swapped);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\ufeff/, ''); }
  catch (_e) {
    try { return new TextDecoder('gb18030').decode(bytes); }
    catch (_e2) { return new TextDecoder('utf-8').decode(bytes); }
  }
}

function fallbackTitle(name) {
  return path.basename(String(name || '未命名书籍')).replace(/\.[^.]+$/, '').trim() || '未命名书籍';
}

function parseTxt(buf, name) {
  const source = decodeTxt(buf).replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  const paragraphs = source.split(/\n{2,}/).map(x => x.trim()).filter(Boolean);
  const segments = [];
  paragraphs.forEach(function (paragraph, index) {
    const lines = paragraph.split('\n').map(x => x.trim()).filter(Boolean);
    const keepLines = index === 0 || lines.some(isChapterTitle) || lines.some(x => /^(?:作者|Author)\s*[:：]/i.test(x));
    if (keepLines) segments.push(...lines);
    else segments.push(lines.join(' '));
  });
  let title = fallbackTitle(name);
  let author = '';
  const first = segments[0] || '';
  if (first && first.length <= 80 && !isChapterTitle(first)) title = first.replace(/^书名[:：]\s*/, '').trim() || title;
  for (const line of segments.slice(0, 12)) {
    const m = line.match(/^(?:作者|Author)\s*[:：]\s*(.+)$/i);
    if (m) { author = m[1].trim().slice(0, 120); break; }
  }
  const blocks = [];
  const chapters = [];
  let chapter = 0;
  const startChapter = label => {
    if (chapters.length) chapters[chapters.length - 1].end_block = Math.max(chapters[chapters.length - 1].start_block, blocks.length - 1);
    chapter = chapters.length;
    chapters.push({ idx: chapter, title: label || (chapter ? `第 ${chapter + 1} 节` : '正文'), start_block: blocks.length, end_block: blocks.length });
  };
  startChapter('正文');
  for (const line of segments) {
    if (!line || line === title || /^(?:作者|Author)\s*[:：]/i.test(line)) continue;
    if (isChapterTitle(line)) startChapter(line);
    const kind = isChapterTitle(line) ? 'head' : 'para';
    for (const piece of normalizeSegments([{ kind, text: line }])) blocks.push({ ...piece, chapter });
  }
  if (!blocks.length) throw new Error('这份 TXT 没有可读取的正文');
  chapters[chapters.length - 1].end_block = blocks.length - 1;
  return { title, author, lang: /[\u3400-\u9fff]/.test(source) ? 'zh' : '', cover: '', blocks, chapters: chapters.filter((c, i) => i === 0 || c.start_block <= c.end_block) };
}

function xmlAttr(value) {
  const out = {};
  String(value || '').replace(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (_m, k, a, b) => { out[k] = a == null ? b : a; return ''; });
  return out;
}

function firstTag(xml, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = String(xml || '').match(re);
  return m ? plainHtml(m[1]) : '';
}

function zipText(zip, key) {
  const hit = zip[String(key || '').replace(/^\/+/, '')];
  return hit ? strFromU8(hit) : '';
}

function parseEpub(buf, name) {
  let zip;
  try { zip = unzipSync(new Uint8Array(buf)); }
  catch (_e) { throw new Error('EPUB 文件损坏，无法解压'); }
  const encryption = zipText(zip, 'META-INF/encryption.xml');
  if (/<EncryptedData\b/i.test(encryption)) throw new Error('这本 EPUB 带有 DRM 或加密资源，暂时无法导入');
  const container = zipText(zip, 'META-INF/container.xml');
  const rootMatch = container.match(/full-path\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
  if (!rootMatch) throw new Error('EPUB 缺少 container.xml 书目入口');
  const opfPath = (rootMatch[1] || rootMatch[2]).replace(/^\/+/, '');
  const opf = zipText(zip, opfPath);
  if (!opf) throw new Error('EPUB 的 OPF 书目信息不可读');
  const base = path.posix.dirname(opfPath);
  const title = firstTag(opf, 'dc:title') || fallbackTitle(name);
  const author = firstTag(opf, 'dc:creator');
  const lang = firstTag(opf, 'dc:language');
  const manifest = {};
  const itemRe = /<item\b([^>]*?)\/?>/gi;
  let im;
  while ((im = itemRe.exec(opf))) {
    const a = xmlAttr(im[1]);
    if (a.id && a.href) manifest[a.id] = { ...a, full: path.posix.normalize(path.posix.join(base, a.href)) };
  }
  const spine = [];
  const spineRe = /<itemref\b([^>]*?)\/?>/gi;
  while ((im = spineRe.exec(opf))) {
    const a = xmlAttr(im[1]);
    if (a.idref && manifest[a.idref]) spine.push(manifest[a.idref]);
  }
  if (!spine.length) throw new Error('EPUB 没有可读取的正文 spine');
  let coverItem = Object.values(manifest).find(x => /\bcover-image\b/.test(x.properties || ''));
  if (!coverItem) {
    const metaCover = opf.match(/<meta\b[^>]*name\s*=\s*["']cover["'][^>]*content\s*=\s*["']([^"']+)["'][^>]*\/?>/i);
    if (metaCover) coverItem = manifest[metaCover[1]];
  }
  let cover = '';
  if (coverItem && zip[coverItem.full] && zip[coverItem.full].length <= 1500000) {
    const mime = coverItem['media-type'] || 'image/jpeg';
    cover = `data:${mime};base64,${Buffer.from(zip[coverItem.full]).toString('base64')}`;
  }
  const blocks = [];
  const chapters = [];
  for (const item of spine) {
    const html = zipText(zip, item.full);
    if (!html) continue;
    const parts = normalizeSegments(htmlSegments(html));
    if (!parts.length) continue;
    const idx = chapters.length;
    const start = blocks.length;
    const heading = parts.find(x => x.kind === 'head');
    const chapterTitle = heading ? heading.text.slice(0, 120) : decodeURIComponent(path.posix.basename(item.href || '').replace(/\.[^.]+$/, '')) || `第 ${idx + 1} 节`;
    for (const part of parts) blocks.push({ ...part, chapter: idx });
    chapters.push({ idx, title: chapterTitle, start_block: start, end_block: blocks.length - 1 });
  }
  if (!blocks.length) throw new Error('EPUB 正文为空，或使用了暂不支持的排版');
  return { title, author, lang, cover, blocks, chapters };
}

export function parseBookBuffer(buf, { name = '', format = '' } = {}) {
  const ext = String(format || path.extname(name).slice(1)).toLowerCase();
  if (ext === 'txt' || ext === 'text') return { ...parseTxt(buf, name), format: 'txt' };
  if (ext === 'epub') return { ...parseEpub(buf, name), format: 'epub' };
  throw new Error('目前支持 TXT 和 EPUB；PDF 会在后续单独接入');
}

export function initBookSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS books(
      id TEXT PRIMARY KEY, title TEXT, author TEXT DEFAULT '', cover TEXT DEFAULT '',
      source TEXT DEFAULT '', lang TEXT DEFAULT '', format TEXT DEFAULT '',
      block_count INTEGER DEFAULT 0, word_count INTEGER DEFAULT 0,
      digest TEXT DEFAULT '', mem_summary TEXT DEFAULT '', mem_summary_n INTEGER DEFAULT 0, mem_summary_at INTEGER DEFAULT 0,
      added_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS book_blocks(
      book_id TEXT, idx INTEGER, chapter INTEGER DEFAULT 0, kind TEXT DEFAULT 'para', text TEXT,
      PRIMARY KEY(book_id, idx)
    );
    CREATE TABLE IF NOT EXISTS book_chapters(
      book_id TEXT, idx INTEGER, title TEXT DEFAULT '', start_block INTEGER, end_block INTEGER,
      summary TEXT DEFAULT '', PRIMARY KEY(book_id, idx)
    );
    CREATE TABLE IF NOT EXISTS book_progress(
      book_id TEXT, who TEXT, block_idx INTEGER DEFAULT 0, pct REAL DEFAULT 0, ts INTEGER,
      PRIMARY KEY(book_id, who)
    );
    CREATE TABLE IF NOT EXISTS book_notes(
      id INTEGER PRIMARY KEY AUTOINCREMENT, book_id TEXT, block_idx INTEGER,
      sel_start INTEGER DEFAULT 0, sel_end INTEGER DEFAULT 0, passage TEXT DEFAULT '',
      author TEXT, text TEXT, parent_id INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0, ts INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_bnotes ON book_notes(book_id, block_idx, ts);
    CREATE TABLE IF NOT EXISTS book_impressions(book_id TEXT, text TEXT, n INTEGER, ts INTEGER);
    CREATE INDEX IF NOT EXISTS idx_bimpr ON book_impressions(book_id, ts);
  `);
  try {
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS book_fts USING fts5(book_id UNINDEXED, idx UNINDEXED, text)');
    ftsReady = true;
  } catch (e) {
    ftsReady = false;
    console.log('[books] FTS5 unavailable, falling back to LIKE:', e.message);
  }
}

function countReadableChars(blocks) {
  return (blocks || []).reduce((n, b) => n + String(b.text || '').replace(/\s/g, '').length, 0);
}

function storeParsedBook(db, dataDir, buf, parsed, { name = '', source = '' } = {}) {
  const id = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24);
  const now = Date.now();
  const ext = parsed.format === 'epub' ? 'epub' : 'txt';
  const booksDir = path.join(dataDir, 'books');
  fs.mkdirSync(booksDir, { recursive: true });
  const originalPath = path.join(booksDir, `${id}.${ext}`);
  if (!fs.existsSync(originalPath)) fs.writeFileSync(originalPath, buf, { mode: 0o600 });
  const wordCount = countReadableChars(parsed.blocks);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO books(id,title,author,cover,source,lang,format,block_count,word_count,added_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,author=excluded.author,cover=CASE WHEN excluded.cover!='' THEN excluded.cover ELSE books.cover END,
      source=excluded.source,lang=excluded.lang,format=excluded.format,block_count=excluded.block_count,word_count=excluded.word_count,updated_at=excluded.updated_at`)
      .run(id, parsed.title, parsed.author || '', parsed.cover || '', source || name || '', parsed.lang || '', ext, parsed.blocks.length, wordCount, now, now);
    db.prepare('DELETE FROM book_blocks WHERE book_id=?').run(id);
    db.prepare('DELETE FROM book_chapters WHERE book_id=?').run(id);
    if (ftsReady) db.prepare('DELETE FROM book_fts WHERE book_id=?').run(id);
    const addBlock = db.prepare('INSERT INTO book_blocks(book_id,idx,chapter,kind,text) VALUES(?,?,?,?,?)');
    const addChapter = db.prepare('INSERT INTO book_chapters(book_id,idx,title,start_block,end_block) VALUES(?,?,?,?,?)');
    const addFts = ftsReady ? db.prepare('INSERT INTO book_fts(book_id,idx,text) VALUES(?,?,?)') : null;
    parsed.blocks.forEach((b, idx) => {
      addBlock.run(id, idx, Number(b.chapter) || 0, b.kind || 'para', b.text || '');
      if (addFts) addFts.run(id, idx, b.text || '');
    });
    parsed.chapters.forEach((c, idx) => addChapter.run(id, idx, c.title || `第 ${idx + 1} 节`, Number(c.start_block) || 0, Number(c.end_block) || 0));
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_e) {}
    throw e;
  }
  return { id, title: parsed.title, author: parsed.author || '', format: ext, block_count: parsed.blocks.length, word_count: wordCount };
}

function bookRow(db, id) {
  return db.prepare('SELECT * FROM books WHERE id=?').get(String(id || '')) || null;
}

function safeBlockIndex(book, value) {
  const max = Math.max(0, Number(book && book.block_count || 0) - 1);
  return Math.max(0, Math.min(max, Math.floor(Number(value) || 0)));
}

export function createBookService({ db, dataDir, assertPublicUrl, fetchCapped, emitEvent = () => {} }) {
  initBookSchema(db);

  function register(app) {
    app.post('/api/books/import', express.raw({ type: ['application/octet-stream', 'application/epub+zip', 'text/plain'], limit: '50mb' }), (q, r) => {
      try {
        const buf = Buffer.isBuffer(q.body) ? q.body : Buffer.from(q.body || []);
        if (!buf.length) return r.status(400).json({ ok: false, error: '没有收到书籍文件' });
        if (buf.length > MAX_BOOK_BYTES) return r.status(413).json({ ok: false, error: '单本书暂时不能超过 50MB' });
        const name = textValue(q.query.name || '未命名书籍', 240);
        const format = textValue(q.query.format || path.extname(name).slice(1), 12).toLowerCase();
        const parsed = parseBookBuffer(buf, { name, format });
        r.json({ ok: true, book: storeParsedBook(db, dataDir, buf, parsed, { name, source: `file:${name}` }) });
      } catch (e) { r.status(400).json({ ok: false, error: e.message }); }
    });

    app.post('/api/books/import-url', async (q, r) => {
      try {
        const url = textValue(q.body && q.body.url, 2000);
        if (!url) return r.status(400).json({ ok: false, error: '请粘贴 TXT 或 EPUB 的直链' });
        await assertPublicUrl(url, { allowHttp: false });
        const { buf, ct, finalUrl } = await fetchCapped(url, { maxBytes: MAX_BOOK_BYTES, timeoutMs: 90000, headers: { 'User-Agent': 'Duetto/1.0 book importer' } });
        const pathname = new URL(finalUrl || url).pathname;
        let name = textValue((q.body && q.body.name) || decodeURIComponent(path.posix.basename(pathname)) || '网络书籍', 240);
        let format = textValue(q.body && q.body.format, 12).toLowerCase() || path.extname(name).slice(1).toLowerCase();
        if (!format && String(ct).includes('epub')) format = 'epub';
        if (!format && String(ct).includes('text')) format = 'txt';
        if (!path.extname(name) && format) name += `.${format}`;
        const parsed = parseBookBuffer(buf, { name, format });
        r.json({ ok: true, book: storeParsedBook(db, dataDir, buf, parsed, { name, source: url }) });
      } catch (e) { r.status(400).json({ ok: false, error: e.message }); }
    });

    app.get('/api/books', (q, r) => {
      try {
        const who = WHO_KEYS.has(String(q.query.who || 'eve')) ? String(q.query.who || 'eve') : 'eve';
        const rows = db.prepare(`SELECT b.*, COALESCE(p.block_idx,0) AS progress_block, COALESCE(p.pct,0) AS progress_pct,
          COALESCE(p.ts,0) AS progress_ts, (SELECT COUNT(*) FROM book_notes n WHERE n.book_id=b.id) AS notes_count
          FROM books b LEFT JOIN book_progress p ON p.book_id=b.id AND p.who=?
          ORDER BY CASE WHEN COALESCE(p.ts,0)>0 THEN p.ts ELSE b.added_at END DESC`).all(who);
        r.json({ ok: true, books: rows });
      } catch (e) { r.status(500).json({ ok: false, error: e.message }); }
    });

    app.get('/api/book', (q, r) => {
      try {
        const book = bookRow(db, q.query.id);
        if (!book) return r.status(404).json({ ok: false, error: '找不到这本书' });
        const chapters = db.prepare('SELECT idx,title,start_block,end_block,summary FROM book_chapters WHERE book_id=? ORDER BY idx').all(book.id);
        r.json({ ok: true, book, chapters });
      } catch (e) { r.status(500).json({ ok: false, error: e.message }); }
    });

    app.get('/api/book/blocks', (q, r) => {
      try {
        const book = bookRow(db, q.query.id);
        if (!book) return r.status(404).json({ ok: false, error: '找不到这本书' });
        const from = safeBlockIndex(book, q.query.from);
        const requestedTo = q.query.to == null ? from + 99 : Math.floor(Number(q.query.to) || from);
        const to = Math.min(Number(book.block_count) - 1, Math.max(from, Math.min(requestedTo, from + MAX_BLOCKS_PAGE - 1)));
        const blocks = db.prepare('SELECT idx,chapter,kind,text FROM book_blocks WHERE book_id=? AND idx BETWEEN ? AND ? ORDER BY idx').all(book.id, from, to);
        r.json({ ok: true, from, to, total: book.block_count, blocks });
      } catch (e) { r.status(500).json({ ok: false, error: e.message }); }
    });

    app.get('/api/book/search', (q, r) => {
      try {
        const id = textValue(q.query.id, 64);
        const query = textValue(q.query.q, 120);
        if (!id || !query) return r.json({ ok: true, results: [] });
        let rows = [];
        if (ftsReady) {
          try { rows = db.prepare('SELECT idx, snippet(book_fts,2,\'〈\',\'〉\',\'…\',18) AS text FROM book_fts WHERE book_id=? AND book_fts MATCH ? LIMIT 60').all(id, query); }
          catch (_e) { rows = []; }
        }
        if (!rows.length) rows = db.prepare("SELECT idx,text FROM book_blocks WHERE book_id=? AND text LIKE ? ORDER BY idx LIMIT 60").all(id, `%${query}%`);
        r.json({ ok: true, results: rows });
      } catch (e) { r.status(500).json({ ok: false, error: e.message }); }
    });

    app.get('/api/book-progress', (q, r) => {
      try {
        const id = textValue(q.query.id, 64);
        const progress = db.prepare('SELECT who,block_idx,pct,ts FROM book_progress WHERE book_id=? ORDER BY who').all(id);
        r.json({ ok: true, progress });
      } catch (e) { r.status(500).json({ ok: false, error: e.message }); }
    });

    app.post('/api/book-progress', (q, r) => {
      try {
        const b = q.body || {};
        const book = bookRow(db, b.id);
        if (!book) return r.status(404).json({ ok: false, error: '找不到这本书' });
        const who = WHO_KEYS.has(String(b.who || 'eve')) ? String(b.who || 'eve') : 'eve';
        const block = safeBlockIndex(book, b.block_idx);
        const ts = Math.max(0, Number(b.ts) || Date.now());
        const pct = book.block_count > 1 ? Math.round((block / (book.block_count - 1)) * 10000) / 100 : 100;
        db.prepare(`INSERT INTO book_progress(book_id,who,block_idx,pct,ts) VALUES(?,?,?,?,?)
          ON CONFLICT(book_id,who) DO UPDATE SET block_idx=excluded.block_idx,pct=excluded.pct,ts=excluded.ts
          WHERE excluded.ts>=book_progress.ts`).run(book.id, who, block, pct, ts);
        r.json({ ok: true, progress: { who, block_idx: block, pct, ts } });
      } catch (e) { r.status(500).json({ ok: false, error: e.message }); }
    });

    app.get('/api/book-notes', (q, r) => {
      try {
        const id = textValue(q.query.id, 64);
        const from = Math.max(0, Math.floor(Number(q.query.from) || 0));
        const to = Math.max(from, Math.floor(Number(q.query.to) || from + 199));
        const notes = db.prepare(`SELECT id,book_id,block_idx,sel_start,sel_end,passage,author,text,parent_id,pinned,ts
          FROM book_notes WHERE book_id=? AND block_idx BETWEEN ? AND ? ORDER BY block_idx,ts,id`).all(id, from, to);
        r.json({ ok: true, notes });
      } catch (e) { r.status(500).json({ ok: false, error: e.message }); }
    });

    app.post('/api/book-note', (q, r) => {
      try {
        const b = q.body || {};
        const book = bookRow(db, b.id);
        if (!book) return r.status(404).json({ ok: false, error: '找不到这本书' });
        let blockIdx = safeBlockIndex(book, b.block_idx);
        let parentId = Math.max(0, Math.floor(Number(b.parent_id) || 0));
        if (parentId) {
          const parent = db.prepare('SELECT id,book_id,block_idx FROM book_notes WHERE id=?').get(parentId);
          if (!parent || parent.book_id !== book.id) return r.status(400).json({ ok: false, error: '回复目标不存在' });
          blockIdx = Number(parent.block_idx);
        }
        const row = db.prepare('SELECT text FROM book_blocks WHERE book_id=? AND idx=?').get(book.id, blockIdx);
        if (!row) return r.status(400).json({ ok: false, error: '批注位置不存在' });
        const passage = textValue(b.passage, 1200);
        if (passage && !String(row.text || '').includes(passage)) return r.status(400).json({ ok: false, error: '划线内容与正文锚点不匹配' });
        const noteText = textValue(b.text, 2400);
        if (!noteText) return r.status(400).json({ ok: false, error: '批注不能是空的' });
        const author = String(b.author || 'eve') === 'yu' ? 'yu' : 'eve';
        const start = Math.max(0, Math.floor(Number(b.sel_start) || 0));
        const end = Math.max(start, Math.floor(Number(b.sel_end) || start));
        const ts = Date.now();
        const result = db.prepare(`INSERT INTO book_notes(book_id,block_idx,sel_start,sel_end,passage,author,text,parent_id,pinned,ts)
          VALUES(?,?,?,?,?,?,?,?,?,?)`).run(book.id, blockIdx, start, end, passage, author, noteText, parentId, b.pinned ? 1 : 0, ts);
        const note = db.prepare('SELECT id,book_id,block_idx,sel_start,sel_end,passage,author,text,parent_id,pinned,ts FROM book_notes WHERE id=?').get(Number(result.lastInsertRowid));
        emitEvent({
          id: `book-note:${note.id}`,
          type: 'com.duetto.book.note.created.v1',
          subject: `book/${encodeURIComponent(book.id)}/note/${note.id}`,
          time: new Date(ts).toISOString(),
          data: {
            actor: author === 'eve' ? 'user' : 'ai',
            book: { id: book.id, title: book.title, author: book.author || '' },
            note: {
              id: String(note.id), block_idx: Number(note.block_idx) || 0,
              passage: note.passage || '', text: note.text || '', parent_id: Number(note.parent_id) || 0,
            },
          },
        });
        r.json({ ok: true, note });
      } catch (e) { r.status(500).json({ ok: false, error: e.message }); }
    });

    app.post('/api/book-note/pin', (q, r) => {
      try {
        const id = Math.max(0, Math.floor(Number(q.body && q.body.id) || 0));
        const pinned = q.body && q.body.pinned === false ? 0 : 1;
        db.prepare('UPDATE book_notes SET pinned=? WHERE id=?').run(pinned, id);
        r.json({ ok: true, pinned: !!pinned });
      } catch (e) { r.status(500).json({ ok: false, error: e.message }); }
    });
  }

  function enrichReading(nr) {
    if (!nr || !nr.id) return nr;
    const book = bookRow(db, nr.id);
    if (!book) return nr;
    const idx = safeBlockIndex(book, nr.block_idx);
    const from = Math.max(0, idx - 6);
    const to = Math.min(Number(book.block_count) - 1, idx + 10);
    const blocks = db.prepare('SELECT idx,chapter,kind,text FROM book_blocks WHERE book_id=? AND idx BETWEEN ? AND ? ORDER BY idx').all(book.id, from, to);
    const chapter = db.prepare('SELECT idx,title,summary FROM book_chapters WHERE book_id=? AND start_block<=? AND end_block>=? ORDER BY idx DESC LIMIT 1').get(book.id, idx, idx);
    const notes = db.prepare(`SELECT block_idx,passage,author,text,parent_id,ts FROM book_notes
      WHERE book_id=? AND block_idx BETWEEN ? AND ? ORDER BY ts DESC,id DESC LIMIT 8`).all(book.id, Math.max(0, idx - 6), Math.min(Number(book.block_count) - 1, idx + 6)).reverse();
    nr.id = book.id;
    nr.title = book.title;
    nr.author = book.author || '';
    nr.block_idx = idx;
    nr.chapter = chapter ? chapter.idx : 0;
    nr.chapter_title = chapter ? chapter.title : '';
    nr.window = blocks.map(x => `[${x.idx}] ${x.text}`).join('\n').slice(0, 3600);
    nr.digest = book.digest || '';
    nr.chap_summary = chapter && chapter.summary || '';
    nr.impression = book.mem_summary || '';
    nr.notes = notes;
    nr.quote = textValue(nr.quote, 1200);
    return nr;
  }

  return { register, enrichReading };
}
