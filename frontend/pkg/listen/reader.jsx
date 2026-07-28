/* listen/reader.jsx — 阅读器：稳定块锚点、进度、划线批注线程、AI 回复与房间同读。 */

const { useState: rUseState, useEffect: rUseEffect, useRef: rUseRef, useMemo: rUseMemo } = React;
const LS_READER_PAGE = 120;

function LSMarkedText({ block, notes }) {
  const text = String(block.text || '');
  const ranges = (notes || []).filter(function (n) {
    return Number(n.sel_end) > Number(n.sel_start) && n.passage;
  }).map(function (n) {
    return { start: Math.max(0, Number(n.sel_start) || 0), end: Math.min(text.length, Number(n.sel_end) || 0), author: n.author, id: n.id };
  }).filter(function (n) { return n.end > n.start; }).sort(function (a, b) { return a.start - b.start || a.end - b.end; });
  if (!ranges.length) return <span className="ls-book-text">{text}</span>;
  const pieces = [];
  let at = 0;
  ranges.forEach(function (range) {
    if (range.start < at) return;
    if (range.start > at) pieces.push(<React.Fragment key={'t' + at}>{text.slice(at, range.start)}</React.Fragment>);
    pieces.push(<mark key={'m' + range.id} className={range.author === 'yu' ? 'is-yu' : 'is-eve'}>{text.slice(range.start, range.end)}</mark>);
    at = range.end;
  });
  if (at < text.length) pieces.push(<React.Fragment key={'t' + at}>{text.slice(at)}</React.Fragment>);
  return <span className="ls-book-text">{pieces}</span>;
}

function LSNoteThread({ root, replies, onReply, onAsk, onPin, aiBusy }) {
  const yuName = (window.LS_PEOPLE && window.LS_PEOPLE.yu && window.LS_PEOPLE.yu.name) || 'TA';
  const eveName = (window.LS_PEOPLE && window.LS_PEOPLE.eve && window.LS_PEOPLE.eve.name) || '我';
  const renderNote = function (note, reply) {
    const isYu = note.author === 'yu';
    return (
      <div className={'ls-book-note' + (isYu ? ' is-yu' : ' is-eve') + (reply ? ' is-reply' : '')} key={note.id}>
        <div className="ls-book-note-head">
          <b>{isYu ? yuName : eveName}</b>
          <span>{window.lsFmtTs ? window.lsFmtTs(note.ts) : ''}</span>
          {note.pinned ? <i>已记住</i> : null}
        </div>
        {note.passage && !reply ? <blockquote>“{note.passage}”</blockquote> : null}
        <p>{note.text}</p>
        <div className="ls-book-note-actions">
          <button onClick={function () { onReply(root); }}>回复</button>
          {!isYu && !reply ? <button disabled={aiBusy} onClick={function () { onAsk(root); }}>{aiBusy ? 'TA 正在读…' : '问 TA'}</button> : null}
          <button onClick={function () { onPin(note); }}>{note.pinned ? '取消记住' : '记住'}</button>
        </div>
      </div>
    );
  };
  return <div className="ls-book-thread">{renderNote(root, false)}{(replies || []).map(function (n) { return renderNote(n, true); })}</div>;
}

function LSReaderView({ bookId, onBack, onOpenRoom }) {
  const [meta, setMeta] = rUseState(null);
  const [chapters, setChapters] = rUseState([]);
  const [blocks, setBlocks] = rUseState([]);
  const [notes, setNotes] = rUseState([]);
  const [from, setFrom] = rUseState(0);
  const [to, setTo] = rUseState(0);
  const [current, setCurrent] = rUseState(0);
  const [loading, setLoading] = rUseState(true);
  const [error, setError] = rUseState('');
  const [selection, setSelection] = rUseState(null);
  const [draft, setDraft] = rUseState('');
  const [saving, setSaving] = rUseState(false);
  const [aiBusy, setAiBusy] = rUseState(0);
  const [follow, setFollow] = rUseState(false);
  const [remote, setRemote] = rUseState(null);
  const [fontSize, setFontSize] = rUseState(function () { return Number(localStorage.getItem('ls-reader-size') || 18); });
  const scrollRef = rUseRef(null);
  const progressTimer = rUseRef(null);
  const scrollTick = rUseRef(0);
  const pendingScroll = rUseRef(null);

  const loadRange = function (target, bookOverride) {
    const book = bookOverride || meta;
    if (!book) return Promise.resolve();
    const total = Number(book.block_count) || 1;
    const safe = Math.max(0, Math.min(total - 1, Number(target) || 0));
    const start = Math.max(0, Math.min(safe > 12 ? safe - 12 : 0, Math.max(0, total - 1)));
    const end = Math.min(total - 1, start + LS_READER_PAGE - 1);
    setLoading(true);
    return Promise.all([
      lsBookApi('/book/blocks?id=' + encodeURIComponent(book.id) + '&from=' + start + '&to=' + end),
      lsBookApi('/book-notes?id=' + encodeURIComponent(book.id) + '&from=' + start + '&to=' + end),
    ]).then(function (all) {
      setBlocks(all[0].blocks || []);
      setNotes(all[1].notes || []);
      setFrom(all[0].from || 0);
      setTo(all[0].to || 0);
      setCurrent(safe);
      setLoading(false);
      pendingScroll.current = safe;
      setTimeout(function () {
        const el = document.querySelector('[data-book-block="' + safe + '"]');
        if (el) el.scrollIntoView({ block: 'start' });
      }, 60);
    }).catch(function (e) {
      setError(e.message);
      setLoading(false);
    });
  };

  rUseEffect(function () {
    let alive = true;
    setLoading(true);
    Promise.all([
      lsBookApi('/book?id=' + encodeURIComponent(bookId)),
      lsBookApi('/book-progress?id=' + encodeURIComponent(bookId)),
    ]).then(function (all) {
      if (!alive) return;
      const book = all[0].book;
      const progress = all[1].progress || [];
      const mine = progress.find(function (p) { return p.who === 'eve'; });
      const theirs = progress.find(function (p) { return p.who === 'yu'; });
      setMeta(book);
      setChapters(all[0].chapters || []);
      if (theirs) setRemote({ block_idx: Number(theirs.block_idx) || 0, pct: Number(theirs.pct) || 0, who: 'yu' });
      return loadRange(mine ? mine.block_idx : 0, book);
    }).catch(function (e) {
      if (alive) { setError(e.message); setLoading(false); }
    });
    return function () { alive = false; };
  }, [bookId]);

  const goTo = function (idx) {
    const target = Math.max(0, Math.min(Number(meta && meta.block_count || 1) - 1, Number(idx) || 0));
    if (target < from || target > to) loadRange(target);
    else {
      setCurrent(target);
      const el = document.querySelector('[data-book-block="' + target + '"]');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  rUseEffect(function () {
    const receive = function (ev) {
      const message = ev && ev.detail;
      if (!message || !message.book || String(message.book.id) !== String(bookId)) return;
      const next = { block_idx: Number(message.block_idx) || 0, pct: Number(message.pct) || 0, who: message.who || 'yu' };
      setRemote(next);
      lsBookApi('/book-progress', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: bookId, who: 'yu', block_idx: next.block_idx, ts: Number(message.ts) || Date.now() }),
      }).catch(function () {});
      if (follow) goTo(next.block_idx);
    };
    window.addEventListener('ls-book-remote', receive);
    return function () { window.removeEventListener('ls-book-remote', receive); };
  }, [bookId, follow, from, to, meta]);

  rUseEffect(function () {
    if (!meta || loading) return;
    clearTimeout(progressTimer.current);
    progressTimer.current = setTimeout(function () {
      const ts = Date.now();
      const pct = Number(meta.block_count) > 1 ? Math.round((current / (Number(meta.block_count) - 1)) * 10000) / 100 : 100;
      lsBookApi('/book-progress', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: meta.id, who: 'eve', block_idx: current, ts: ts }),
      }).catch(function () {});
      try {
        if (window.__LS_SYNC && window.__LS_SYNC.send) window.__LS_SYNC.send({
          t: 'read', book: { id: meta.id, title: meta.title, author: meta.author || '' },
          block_idx: current, pct: pct, who: 'eve', ts: ts,
        });
      } catch (e) {}
    }, 850);
    return function () { clearTimeout(progressTimer.current); };
  }, [current, meta && meta.id, loading]);

  rUseEffect(function () {
    try { localStorage.setItem('ls-reader-size', String(fontSize)); } catch (e) {}
  }, [fontSize]);

  const onScroll = function () {
    if (scrollTick.current) return;
    scrollTick.current = requestAnimationFrame(function () {
      scrollTick.current = 0;
      const host = scrollRef.current;
      if (!host) return;
      const top = host.getBoundingClientRect().top + 118;
      let best = null;
      host.querySelectorAll('[data-book-block]').forEach(function (el) {
        const d = Math.abs(el.getBoundingClientRect().top - top);
        if (!best || d < best.d) best = { d: d, idx: Number(el.getAttribute('data-book-block')) || 0 };
      });
      if (best && pendingScroll.current == null) setCurrent(best.idx);
      if (pendingScroll.current != null) pendingScroll.current = null;
    });
  };

  const captureSelection = function () {
    setTimeout(function () {
      const sel = window.getSelection && window.getSelection();
      if (!sel || sel.rangeCount < 1 || sel.isCollapsed) return;
      const range = sel.getRangeAt(0);
      const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
      const endEl = range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement;
      const startBlock = startEl && startEl.closest && startEl.closest('[data-book-block]');
      const endBlock = endEl && endEl.closest && endEl.closest('[data-book-block]');
      if (!startBlock || !endBlock || startBlock !== endBlock) return;
      const textRoot = startBlock.querySelector('.ls-book-text');
      if (!textRoot || !textRoot.contains(range.startContainer) || !textRoot.contains(range.endContainer)) return;
      const before = document.createRange();
      before.selectNodeContents(textRoot);
      before.setEnd(range.startContainer, range.startOffset);
      const start = before.toString().length;
      const passage = range.toString().replace(/\s+/g, ' ').trim();
      if (!passage || passage.length > 1200) return;
      setSelection({
        block_idx: Number(startBlock.getAttribute('data-book-block')) || 0,
        sel_start: start, sel_end: start + range.toString().length, passage: passage, parent_id: 0,
      });
      setDraft('');
    }, 20);
  };

  const postNote = function (payload) {
    return lsBookApi('/book-note', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (d) {
      setNotes(function (list) { return (list || []).concat([d.note]); });
      return d.note;
    });
  };

  const saveDraft = async function (askAfter) {
    const text = draft.trim();
    if (!selection || !text || saving) return;
    setSaving(true);
    setError('');
    try {
      const note = await postNote({
        id: bookId, block_idx: selection.block_idx, sel_start: selection.sel_start || 0, sel_end: selection.sel_end || 0,
        passage: selection.parent_id ? '' : selection.passage || '', author: 'eve', text: text, parent_id: selection.parent_id || 0,
      });
      setSelection(null);
      setDraft('');
      try { window.getSelection && window.getSelection().removeAllRanges(); } catch (e) {}
      if (askAfter) await askAI(selection.parent_id ? notes.find(function (n) { return n.id === selection.parent_id; }) || note : note);
    } catch (e) { setError(e.message); }
    setSaving(false);
  };

  const askAI = async function (root) {
    if (!root || aiBusy) return;
    setAiBusy(root.id);
    setError('');
    try {
      const thread = [root].concat(notes.filter(function (n) { return Number(n.parent_id) === Number(root.id); }));
      const history = thread.map(function (n) { return { role: n.author === 'yu' ? 'assistant' : 'user', content: n.text }; });
      const prompt = '我在正文旁边写了一条批注。请贴着这段文字回应我，像共同阅读时写在页边的一句话，不要讲课。\n'
        + (root.passage ? ('原文：「' + root.passage + '」\n') : '') + '我的批注：' + root.text;
      const d = await lsBookApi('/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'book', prompt: prompt, history: history.slice(0, -1), ai: window.__lsAiConfig ? window.__lsAiConfig() : undefined,
          nowReading: { id: bookId, block_idx: root.block_idx, quote: root.passage || '' },
        }),
      });
      await postNote({ id: bookId, block_idx: root.block_idx, passage: '', author: 'yu', text: d.reply || '我在。', parent_id: root.id });
    } catch (e) { setError(e.message); }
    setAiBusy(0);
  };

  const pinNote = function (note) {
    const next = !note.pinned;
    lsBookApi('/book-note/pin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: note.id, pinned: next }),
    }).then(function () {
      setNotes(function (list) { return list.map(function (n) { return n.id === note.id ? Object.assign({}, n, { pinned: next ? 1 : 0 }) : n; }); });
    }).catch(function (e) { setError(e.message); });
  };

  const grouped = rUseMemo(function () {
    const out = {};
    (notes || []).forEach(function (n) { (out[n.block_idx] || (out[n.block_idx] = [])).push(n); });
    return out;
  }, [notes]);

  const currentChapter = chapters.find(function (c) {
    return current >= Number(c.start_block) && current <= Number(c.end_block);
  });
  const pct = meta && Number(meta.block_count) > 1 ? Math.max(0, Math.min(100, current / (Number(meta.block_count) - 1) * 100)) : 0;

  if (!meta && loading) return <div className="ls-body ls-book-empty">正在把书翻到上次那一页…</div>;

  return (
    <div className="ls-body ls-reader">
      <div className="ls-reader-head">
        <button className="ls-reader-back" onClick={onBack} aria-label="回到书架">‹</button>
        <div className="ls-reader-title"><b>{meta ? meta.title : '阅读'}</b><span>{currentChapter ? currentChapter.title : (meta && meta.author) || ''}</span></div>
        <button className={'ls-reader-follow' + (follow ? ' on' : '')} onClick={function () { setFollow(function (v) { return !v; }); }}>
          <i></i>{follow ? '跟随 TA' : '各读各的'}
        </button>
      </div>

      <div className="ls-reader-progress">
        <i style={{ width: pct + '%' }}></i>
        {remote && meta && Number(meta.block_count) > 1 ? <b title={'TA 读到 ' + (remote.pct || 0).toFixed(1) + '%'} style={{ left: Math.max(0, Math.min(100, remote.block_idx / (Number(meta.block_count) - 1) * 100)) + '%' }}></b> : null}
      </div>

      <div className="ls-reader-tools">
        <select value={currentChapter ? currentChapter.idx : 0} onChange={function (e) {
          const chapter = chapters.find(function (c) { return Number(c.idx) === Number(e.target.value); });
          if (chapter) goTo(chapter.start_block);
        }}>
          {chapters.map(function (c) { return <option key={c.idx} value={c.idx}>{c.title}</option>; })}
        </select>
        <div className="ls-reader-size">
          <button onClick={function () { setFontSize(function (v) { return Math.max(15, v - 1); }); }}>A−</button>
          <span>{fontSize}</span>
          <button onClick={function () { setFontSize(function (v) { return Math.min(28, v + 1); }); }}>A＋</button>
        </div>
        <button className="ls-reader-room" onClick={function () {
          window.__lsPendingQuote = { line: '', kind: 'book', book: meta && meta.title, book_id: bookId, block_idx: current };
          onOpenRoom && onOpenRoom();
        }}>房间</button>
      </div>

      {error ? <div className="ls-reader-error">{error}<button onClick={function () { setError(''); }}>×</button></div> : null}

      <div className="ls-reader-scroll" ref={scrollRef} onScroll={onScroll} onMouseUp={captureSelection} onTouchEnd={captureSelection} style={{ '--reader-size': fontSize + 'px' }}>
        {loading ? <div className="ls-reader-loading">正在翻页…</div> : null}
        {blocks.map(function (block) {
          const blockNotes = grouped[block.idx] || [];
          const roots = blockNotes.filter(function (n) { return !Number(n.parent_id); });
          return (
            <article className={'ls-reading-block kind-' + block.kind} data-book-block={block.idx} key={block.idx}>
              <div className="ls-reading-index">{block.idx}</div>
              {block.kind === 'head'
                ? <h2><LSMarkedText block={block} notes={blockNotes} /></h2>
                : block.kind === 'quote'
                  ? <blockquote className="ls-reading-copy"><LSMarkedText block={block} notes={blockNotes} /></blockquote>
                  : <p className="ls-reading-copy"><LSMarkedText block={block} notes={blockNotes} /></p>}
              {roots.length ? <div className="ls-book-notes">{roots.map(function (root) {
                return <LSNoteThread key={root.id} root={root} replies={blockNotes.filter(function (n) { return Number(n.parent_id) === Number(root.id); })} aiBusy={aiBusy === root.id}
                  onReply={function (note) { setSelection({ block_idx: note.block_idx, passage: note.passage || '', parent_id: note.id }); setDraft(''); }}
                  onAsk={askAI} onPin={pinNote} />;
              })}</div> : null}
            </article>
          );
        })}

        {!loading && meta ? (
          <div className="ls-reader-pager">
            <button disabled={from <= 0} onClick={function () { loadRange(Math.max(0, from - LS_READER_PAGE)); }}>上一段</button>
            <span>{Math.min(Number(meta.block_count), to + 1)} / {meta.block_count}</span>
            <button disabled={to >= Number(meta.block_count) - 1} onClick={function () { loadRange(to + 1); }}>继续往下</button>
          </div>
        ) : null}
      </div>

      {selection ? (
        <div className="ls-book-compose">
          <div className="ls-book-compose-quote">
            <span>{selection.parent_id ? '回复这条批注' : ('“' + selection.passage + '”')}</span>
            <button onClick={function () { setSelection(null); setDraft(''); }}>×</button>
          </div>
          <textarea autoFocus value={draft} onChange={function (e) { setDraft(e.target.value); }} placeholder={selection.parent_id ? '写下回复…' : '在页边写点什么…'} />
          <div className="ls-book-compose-actions">
            {!selection.parent_id ? <button className="room" onClick={function () {
              window.__lsPendingQuote = { line: selection.passage, kind: 'book', book: meta && meta.title, book_id: bookId, block_idx: selection.block_idx };
              setSelection(null); setDraft(''); onOpenRoom && onOpenRoom();
            }}>发到房间</button> : <span></span>}
            <button disabled={!draft.trim() || saving} onClick={function () { saveDraft(false); }}>存批注</button>
            {!selection.parent_id ? <button className="ask" disabled={!draft.trim() || saving} onClick={function () { saveDraft(true); }}>存下并问 TA</button> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

Object.assign(window, { LSReaderView, LSMarkedText, LSNoteThread });
