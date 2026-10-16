/* listen/reader.jsx — 阅读器：稳定块锚点、进度、划线批注线程、AI 回复与房间同读。 */

const { useState: rUseState, useEffect: rUseEffect, useRef: rUseRef, useMemo: rUseMemo } = React;
const LS_READER_PAGE = 120;
function lsReadingChat(options) {
  const payload=JSON.parse(options.body);
  if(window.__OMBRE_EMBED && window.parent !== window) return window.__ombreBookChat(payload);
  return lsBookApi('/chat',options);
}

function LSMarkedText({ block, notes, expanded, onToggle }) {
  const text = String(block.text || '');
  const roots = (notes || []).filter(n => !Number(n.parent_id));
  const ranges = roots.map(function(n) {
    let start = Math.max(0, Number(n.sel_start) || 0);
    let end = Math.min(text.length, Number(n.sel_end) || 0);
    if (end <= start && n.passage) {
      const found = text.indexOf(n.passage);
      if (found >= 0) {start = found; end = found + n.passage.length;}
    }
    // Older paragraph conversations may have no stored selection offsets.
    if (end <= start) {start = 0; end = text.length;}
    return {start, end, author:n.author};
  }).filter(n => n.end > n.start).sort((a,b) => a.start - b.start || a.end - b.end);
  const merged = [];
  ranges.forEach(function(range) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push(Object.assign({}, range));
  });
  const pieces = [];
  let at = 0;
  merged.forEach(function(range) {
    if (range.start > at) pieces.push(<React.Fragment key={'t'+at}>{text.slice(at,range.start)}</React.Fragment>);
    const toggle = function(e) {
      if (window.getSelection && !window.getSelection().isCollapsed) return;
      e.stopPropagation(); onToggle();
    };
    pieces.push(<mark key={'m'+range.start} className={range.author === 'yu' ? 'is-yu' : 'is-eve'}
      role="button" tabIndex={0} aria-label="查看这段对话" aria-expanded={expanded} aria-controls={'book-notes-'+block.idx}
      onClick={toggle} onDoubleClick={e => e.stopPropagation()}
      onKeyDown={function(e){if(e.key === 'Enter' || e.key === ' '){e.preventDefault();toggle(e);}}}>
      {text.slice(range.start,range.end)}</mark>);
    at = range.end;
  });
  if (at < text.length) pieces.push(<React.Fragment key={'t'+at}>{text.slice(at)}</React.Fragment>);
  return <span className="ls-book-text">{pieces}</span>;
}

function LSNoteThread({ root, replies, onReply, onAsk, onPin, onEmotion, aiBusy }) {
  const yuName = (window.LS_PEOPLE && window.LS_PEOPLE.yu && window.LS_PEOPLE.yu.name) || 'TA';
  const eveName = (window.LS_PEOPLE && window.LS_PEOPLE.eve && window.LS_PEOPLE.eve.name) || '我';
  const renderNote = function (note, reply) {
    const isYu = note.author === 'yu';
    return (
      <div className={'ls-book-note' + (isYu ? ' is-yu' : ' is-eve') + (reply ? ' is-reply' : '')} key={note.id}>
        <div className="ls-book-note-head">
          <b>{isYu ? yuName : eveName}</b>
          <span>{window.lsFmtTs ? window.lsFmtTs(note.ts) : ''}</span>
          {note.remembered ? <i>已记住</i> : null}
        </div>
        {note.passage && !reply ? <blockquote>“{note.passage}”</blockquote> : null}
        <p>{note.text}</p>
        <div className="ls-book-emotions" aria-label="这段话的情绪标签">
          {['😭','🙂','😡','🤯'].map(function (emoji) {
            const mine = (note.emotions || []).some(function (e) { return e.actor === 'eve' && e.emoji === emoji; });
            return <button key={emoji} aria-label={'我的感受 ' + emoji} aria-pressed={mine} onClick={function () { onEmotion(note, mine ? '' : emoji, 'eve'); }}>{emoji}</button>;
          })}
          {(note.emotions || []).filter(function (e) { return e.actor === 'yu'; }).map(function (e) { return <span key={e.actor}>{yuName} {e.emoji}</span>; })}
        </div>
        <div className="ls-book-note-actions">
          <button onClick={function () { onReply(root); }}>回复</button>
          {!isYu && !reply ? <button disabled={aiBusy} onClick={function () { onAsk(root); }}>{aiBusy ? '她正在读…' : '叫她来'}</button> : null}
          <button onClick={function () { onPin(note); }}>{note.remembered ? '取消记住' : '记住'}</button>
        </div>
      </div>
    );
  };
  return <div className="ls-book-thread">{renderNote(root, false)}{(replies || []).map(function (n) { return renderNote(n, true); })}</div>;
}

function LSParagraphHandle({ block, onSelect }) {
  const hold = rUseRef(null);
  const cancel = function () { if (hold.current) clearTimeout(hold.current.timer); hold.current = null; };
  rUseEffect(function () { return cancel; }, []);
  return <button className="ls-reading-index" aria-label={'选中第 ' + block.idx + ' 段并提问'}
    onPointerDown={function(e){cancel();hold.current={x:e.clientX,y:e.clientY,timer:setTimeout(function(){cancel();onSelect(block);},550)};}}
    onPointerMove={function(e){if(hold.current && Math.hypot(e.clientX-hold.current.x,e.clientY-hold.current.y)>10)cancel();}}
    onPointerUp={cancel} onPointerCancel={cancel} onPointerLeave={cancel}
    onContextMenu={function(e){e.preventDefault();}}
    onClick={function(e){if(e.detail===0)onSelect(block);}}
  >{block.idx}</button>;
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
  const syncReading = function() { if(window.__ombreSyncReading) void window.__ombreSyncReading().catch(function(){}); };

  const [selection, setSelection] = rUseState(null);
  const [draft, setDraft] = rUseState('');
  const [saving, setSaving] = rUseState(false);
  const [aiBusy, setAiBusy] = rUseState(0);
  const [expanded, setExpanded] = rUseState({});
  const [panel, setPanel] = rUseState('');
  const reviewOpen = panel === 'review';
  const [hostControls, setHostControls] = rUseState(!!window.__ombreReaderHost);
  rUseEffect(function() {
    const hosted = function(){setHostControls(true);};
    const command = function(e){
      if(e.detail === 'back') onBack();
      else setPanel(current => current === e.detail ? '' : e.detail);
    };
    window.addEventListener('ombre:reader-host',hosted);
    window.addEventListener('ombre:reader-command',command);
    return function(){
      window.removeEventListener('ombre:reader-host',hosted);
      window.removeEventListener('ombre:reader-command',command);
      if(window.__ombreSetReaderState) window.__ombreSetReaderState({active:false});
    };
  },[onBack]);
  rUseEffect(function(){
    if(window.__ombreSetReaderState) window.__ombreSetReaderState({active:true,title:meta?.title || '共读',panel});
  },[meta?.title,panel,hostControls,onBack]);
  const [reviewFrom, setReviewFrom] = rUseState(1);
  const [reviewTo, setReviewTo] = rUseState(5);
  const [reviewDays, setReviewDays] = rUseState(0);
  const [reviewText, setReviewText] = rUseState('');
  const [reviewBusy, setReviewBusy] = rUseState(false);
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
      setReviewTo(Math.min(5, (all[0].chapters || []).length || 1));
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
      }).then(function (d) {
        if (window.parent !== window) window.parent.postMessage({ type: 'duetto:reading-position', position: Object.assign({}, d.progress, { book_id: meta.id, title: meta.title }) }, '*');
      }).catch(function (e) { setError('阅读位置尚未同步：' + e.message); });
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
      const top = host.getBoundingClientRect().top + 24;
      let best = null;
      host.querySelectorAll('[data-book-block]').forEach(function (el) {
        const d = Math.abs(el.getBoundingClientRect().top - top);
        if (!best || d < best.d) best = { d: d, idx: Number(el.getAttribute('data-book-block')) || 0 };
      });
      if (best && pendingScroll.current == null) setCurrent(best.idx);
      if (pendingScroll.current != null) pendingScroll.current = null;
    });
  };

  const selectParagraph = function (block) {
    window.getSelection()?.removeAllRanges();
    setSelection({block_idx:block.idx, sel_start:0, sel_end:block.text.length, passage:block.text, parent_id:0});
    setDraft('');
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
    }, 20);
  };

  rUseEffect(function () {
    document.addEventListener('selectionchange', captureSelection);
    return function () { document.removeEventListener('selectionchange', captureSelection); };
  }, [bookId]);

  const setEmotion = async function (note, emoji, actor) {
    try {
      const d = await lsBookApi('/book-note/emotion', { method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ id:bookId, note_id:note.id, actor:actor, emoji:emoji }) });
      setNotes(function (list) { return list.map(function (n) { return n.id === note.id ? d.note : n; }); });
      syncReading();
    } catch(e) { setError(e.message); }
  };

  const reviewBook = async function () {
    if (reviewBusy) return;
    setReviewBusy(true); setError('');
    try {
      let after = 0, collected = [];
      const since = reviewDays ? Date.now() - Number(reviewDays) * 86400000 : 0;
      do {
        const d = await lsBookApi('/book-review?id=' + encodeURIComponent(bookId) + '&from_chapter=' + reviewFrom + '&to_chapter=' + reviewTo + '&since=' + since + '&after=' + after);
        collected = collected.concat(d.notes || []); after = d.next;
        if (collected.length > 500 || JSON.stringify(collected).length > 90000) throw new Error('记录较多，请缩小章节或时间范围再整理。');
      } while(after);
      if (!collected.length) { setReviewText('这段范围里还没有高亮或讨论。'); return; }
      const d = await lsReadingChat({ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({
        kind:'book', prompt:'请按章节回顾我们一起读过的重点，包含画线原文、我的想法、你的补充和双方的情绪标签。明确标出章节和段落；没有记录的内容不要补写。',
        history:[], ai:window.__lsAiConfig ? window.__lsAiConfig() : undefined,
        nowReading:{ id:bookId, title:meta?.title, block_idx:current, mode:'review' }, readingReview:collected
      }) });
      if (!d.reply) throw new Error('她暂时没有返回整理内容，请重试。');
      setReviewText(d.reply);
    } catch(e) { setError(e.message); }
    finally { setReviewBusy(false); }
  };

  const postNote = function (payload) {
    return lsBookApi('/book-note', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (d) {
      setNotes(function (list) { return (list || []).concat([d.note]); });
      syncReading();
      return d.note;
    });
  };

  const saveDraft = async function (askAfter) {
    const text = draft.trim() || (askAfter ? "这句话你怎么看？" : "");
    if (!selection || !text || saving) return;
    setSaving(true);
    setError('');
    try {
      const note = await postNote({
        id: bookId, block_idx: selection.block_idx, sel_start: selection.sel_start || 0, sel_end: selection.sel_end || 0,
        passage: selection.parent_id ? '' : selection.passage || '', author: 'eve', text: text, parent_id: selection.parent_id || 0,
      });
      setExpanded(function (x) { return Object.assign({}, x, { [selection.block_idx]: true }); });
      setSelection(null);
      setDraft('');
      try { window.getSelection && window.getSelection().removeAllRanges(); } catch (e) {}
      if (askAfter) await askAI(selection.parent_id ? notes.find(function (n) { return n.id === selection.parent_id; }) || note : note, note);
    } catch (e) { setError(e.message); }
    setSaving(false);
  };

  const askAI = async function (root, newNote) {
    if (!root || aiBusy) return;
    setAiBusy(root.id);
    setError('');
    try {
      const thread = [root].concat(notes.filter(function (n) { return Number(n.parent_id) === Number(root.id); }));
      if (newNote && !thread.some(function(n){return n.id===newNote.id;})) thread.push(newNote);
      const history = thread.map(function (n) { return { role: n.author === 'yu' ? 'assistant' : 'user', content: n.text }; });
      const prompt = '我在正文旁边写了一条批注。请贴着这段文字回应我，像共同阅读时写在页边的一句话，不要讲课。\n'
        + (root.passage ? ('原文：「' + root.passage + '」\n') : '') + '当前想法：' + (newNote ? newNote.text : root.text) + '\n这条高亮的情绪标签：' + JSON.stringify(root.emotions || []);
      const d = await lsReadingChat({
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'book', prompt: prompt, history: history, ai: window.__lsAiConfig ? window.__lsAiConfig() : undefined,
          nowReading: { id: bookId, title:meta?.title, chapter:chapters.slice().reverse().find(c=>c.start_block<=root.block_idx)?.title, block_idx: root.block_idx, quote: root.passage || '', mode: 'selection' },
        }),
      });
      if (!d.reply || !d.reply.trim()) throw new Error('她暂时没有返回回复，请重试。');
      await postNote({ id: bookId, block_idx: root.block_idx, passage: '', author: 'yu', text: d.reply, parent_id: root.id });
      if (d.emotion) await setEmotion(root, d.emotion, 'yu');
    } catch (e) { setError(e.message); }
    setAiBusy(0);
  };

  const pinNote = async function (note) {
    const next = !note.remembered;
    try {
      if (!window.__ombreRememberReading || window.parent === window) throw new Error('请在 Entangle 内打开共读，才能保存到她的长期记忆。');
      const receipt = await window.__ombreRememberReading(bookId,note.id,next);
      await lsBookApi('/book-note/pin', {method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({id:note.id,pinned:next,memory_id:receipt.memory_id})});
      setNotes(function(list){return list.map(function(n){return n.id===note.id?Object.assign({},n,{pinned:next?1:0,remembered:next}):n;});});
    } catch(e) {setError('记忆操作未完成：'+e.message);}
  };

  const grouped = rUseMemo(function () {
    const out = {};
    (notes || []).forEach(function (n) { (out[n.block_idx] || (out[n.block_idx] = [])).push(n); });
    return out;
  }, [notes]);

  const currentChapter = chapters.slice().reverse().find(function (c) {
    return current >= Number(c.start_block) && current <= Number(c.end_block);
  });
  const pct = meta && Number(meta.block_count) > 1 ? Math.max(0, Math.min(100, current / (Number(meta.block_count) - 1) * 100)) : 0;

  if (!meta && loading) return <div className="ls-body ls-book-empty">正在把书翻到上次那一页…</div>;

  return (
    <div className="ls-body ls-reader">
      {!hostControls ? <header className="ls-reader-compact-head">
        <button onClick={onBack} aria-label="回到书架">‹</button>
        <strong>{meta?.title || '共读'}</strong>
        <button aria-expanded={panel === 'contents'} onClick={() => setPanel(panel === 'contents' ? '' : 'contents')}>目录</button>
        <button aria-expanded={reviewOpen} onClick={() => setPanel(reviewOpen ? '' : 'review')}>回顾</button>
      </header> : null}
      {panel === 'contents' ? <nav className="ls-reader-contents" aria-label="目录">
        <div className="ls-reader-panel-heading"><strong>目录</strong><button onClick={() => setPanel('')} aria-label="关闭目录">×</button></div>
        {chapters.length ? chapters.map(c => <button key={c.idx} aria-current={currentChapter?.idx === c.idx ? 'location' : undefined}
          onClick={() => {goTo(c.start_block);setPanel('');}}>{c.title}</button>) : <p>暂无目录</p>}
      </nav> : null}
      {reviewOpen ? <section className="ls-reader-review" aria-label="回顾">
        <div className="ls-reader-panel-heading"><strong>回顾</strong><button onClick={() => setPanel('')} aria-label="关闭回顾">×</button></div>
        <label>从第 <input aria-label="起始章节" type="number" min="1" value={reviewFrom} onChange={function(e){setReviewFrom(Number(e.target.value));}}/> 节</label>
        <label>到第 <input aria-label="结束章节" type="number" min="1" max={chapters.length} value={reviewTo} onChange={function(e){setReviewTo(Number(e.target.value));}}/> 节</label>
        <select aria-label="复盘时间范围" value={reviewDays} onChange={function(e){setReviewDays(Number(e.target.value));}}><option value="0">全部时间</option><option value="7">最近 7 天</option><option value="30">最近 30 天</option></select>
        <button disabled={reviewBusy} onClick={reviewBook}>{reviewBusy ? '正在整理…' : '一起复盘'}</button>
        <pre>{reviewText}</pre>
      </section> : null}
      {error ? <div className="ls-reader-error">{error}<button onClick={function () { setError(''); }}>×</button></div> : null}

      <div className="ls-reader-scroll" ref={scrollRef} onScroll={onScroll} onMouseUp={captureSelection} onTouchEnd={captureSelection} style={{ '--reader-size': fontSize + 'px' }}>
        {loading ? <div className="ls-reader-loading">正在翻页…</div> : null}
        {blocks.map(function (block) {
          const blockNotes = grouped[block.idx] || [];
          const roots = blockNotes.filter(function (n) { return !Number(n.parent_id); });
          return (
            <article className={'ls-reading-block kind-' + block.kind} data-book-block={block.idx} key={block.idx}
              onDoubleClick={function(e){if(!e.target.closest('mark') && e.target.closest('.ls-book-text')){e.preventDefault();selectParagraph(block);}}}>
              <LSParagraphHandle block={block} onSelect={selectParagraph} />
              {block.kind === 'head'
                ? <h2><LSMarkedText block={block} notes={blockNotes} expanded={!!expanded[block.idx]}
                    onToggle={() => setExpanded(x => Object.assign({},x,{[block.idx]:!x[block.idx]}))} /></h2>
                : block.kind === 'quote'
                  ? <blockquote className="ls-reading-copy"><LSMarkedText block={block} notes={blockNotes} expanded={!!expanded[block.idx]}
                    onToggle={() => setExpanded(x => Object.assign({},x,{[block.idx]:!x[block.idx]}))} /></blockquote>
                  : <p className="ls-reading-copy"><LSMarkedText block={block} notes={blockNotes} expanded={!!expanded[block.idx]}
                    onToggle={() => setExpanded(x => Object.assign({},x,{[block.idx]:!x[block.idx]}))} /></p>}
              {roots.length && expanded[block.idx] ? <div className="ls-book-notes" id={'book-notes-'+block.idx}>{roots.map(function (root) {
                return <LSNoteThread key={root.id} root={root} replies={blockNotes.filter(function (n) { return Number(n.parent_id) === Number(root.id); })} aiBusy={aiBusy === root.id}
                  onReply={function (note) { setSelection({ block_idx: note.block_idx, passage: note.passage || '', parent_id: note.id }); setDraft(''); }}
                  onAsk={askAI} onPin={pinNote} onEmotion={setEmotion} />;
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
          <textarea value={draft} onChange={function (e) { setDraft(e.target.value); }} placeholder={selection.parent_id ? '写下回复…' : '在页边写点什么…'} />
          <div className="ls-book-compose-actions">
            {!selection.parent_id ? <button className="room" onClick={function () {
              window.__lsPendingQuote = { line: selection.passage, kind: 'book', book: meta && meta.title, book_id: bookId, block_idx: selection.block_idx };
              setSelection(null); setDraft(''); onOpenRoom && onOpenRoom();
            }}>发到房间</button> : <span></span>}
            <button disabled={!draft.trim() || saving} onClick={function () { saveDraft(false); }}>存批注</button>
            {!selection.parent_id ? <button className="ask" disabled={saving || !!aiBusy} onClick={function () { saveDraft(true); }}>{draft.trim() ? '存下并叫她来' : '问她'}</button> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

Object.assign(window, { LSReaderView, LSMarkedText, LSNoteThread });
