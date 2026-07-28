/* listen/book.jsx — 共读书架：TXT / EPUB 本地批量导入、直链导入与继续阅读。 */

const { useState: bUseState, useEffect: bUseEffect, useRef: bUseRef } = React;

function lsBookApi(path, options) {
  return fetch((window.__LS_API || '/api') + path, options).then(async function (r) {
    const body = await r.json().catch(function () { return null; });
    if (!r.ok || !body || body.ok === false) throw new Error((body && body.error) || ('请求失败 · ' + r.status));
    return body;
  });
}

function lsBookCount(n) {
  const value = Number(n) || 0;
  if (value >= 10000) return (value / 10000).toFixed(value >= 100000 ? 0 : 1) + ' 万字';
  return value + ' 字';
}

function LSBookCover({ book, large }) {
  const title = (book && book.title) || '书';
  if (book && book.cover) {
    return <div className={'ls-book-cover' + (large ? ' is-large' : '')}><img src={book.cover} alt="" /></div>;
  }
  const colors = ['#70867a', '#8f7b70', '#7a7893', '#9a8667', '#6f8492'];
  let code = 0;
  for (let i = 0; i < title.length; i++) code += title.charCodeAt(i);
  const color = colors[code % colors.length];
  return (
    <div className={'ls-book-cover is-fallback' + (large ? ' is-large' : '')} style={{ '--book-cover': color }}>
      <span className="ls-book-cover-mark">DUETTO<br />READS</span>
      <b>{title.slice(0, 12)}</b>
      <i>{(book && book.author) || '我们的书'}</i>
    </div>
  );
}

function LSShelfView({ onOpenBook }) {
  const [books, setBooks] = bUseState([]);
  const [loading, setLoading] = bUseState(true);
  const [importing, setImporting] = bUseState(false);
  const [status, setStatus] = bUseState('');
  const [urlOpen, setUrlOpen] = bUseState(false);
  const [url, setUrl] = bUseState('');
  const inputRef = bUseRef(null);

  const load = function () {
    setLoading(true);
    return lsBookApi('/books?who=eve').then(function (d) {
      setBooks(d.books || []);
      setLoading(false);
    }).catch(function (e) {
      setStatus(e.message);
      setLoading(false);
    });
  };

  bUseEffect(function () { load(); }, []);

  const importFiles = async function (files) {
    const list = Array.from(files || []).filter(function (file) {
      return /\.(txt|epub)$/i.test(file.name || '');
    });
    if (!list.length) { setStatus('请选择 TXT 或 EPUB 文件'); return; }
    setImporting(true);
    let ok = 0;
    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      setStatus('正在整理 ' + (i + 1) + ' / ' + list.length + ' · ' + file.name);
      try {
        await lsBookApi('/books/import?name=' + encodeURIComponent(file.name) + '&format=' + encodeURIComponent((file.name.split('.').pop() || '').toLowerCase()), {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file,
        });
        ok++;
      } catch (e) {
        setStatus(file.name + '：' + e.message);
      }
    }
    await load();
    setImporting(false);
    setStatus(ok === list.length ? ('已收好 ' + ok + ' 本书') : ('成功 ' + ok + ' / ' + list.length + ' 本'));
    if (inputRef.current) inputRef.current.value = '';
  };

  const importUrl = async function () {
    const value = url.trim();
    if (!value || importing) return;
    setImporting(true);
    setStatus('正在从直链取书…');
    try {
      await lsBookApi('/books/import-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: value }),
      });
      setUrl('');
      setUrlOpen(false);
      setStatus('这本书已经放进书架');
      await load();
    } catch (e) { setStatus(e.message); }
    setImporting(false);
  };

  return (
    <div className="ls-body ls-bookshelf">
      <section className="ls-book-hero">
        <div className="ls-book-hero-copy">
          <span className="eyebrow">ONE ROOM · TWO WAYS TO STAY</span>
          <h2>一起听，也一起读。</h2>
          <p>歌声和书页留在同一个房间里。划下你在意的句子，TA 能看见、批注，也能在旁边回你。</p>
        </div>
        <div className="ls-book-hero-actions">
          <button className="primary" disabled={importing} onClick={function () { inputRef.current && inputRef.current.click(); }}>
            <span>＋</span>{importing ? '正在导入' : '放几本书进来'}
          </button>
          <button className="quiet" onClick={function () { setUrlOpen(function (v) { return !v; }); }}>粘贴书籍直链</button>
          <input ref={inputRef} hidden type="file" accept=".txt,.epub,text/plain,application/epub+zip" multiple onChange={function (e) { importFiles(e.target.files); }} />
        </div>
        {urlOpen && (
          <div className="ls-book-url">
            <input value={url} onChange={function (e) { setUrl(e.target.value); }} onKeyDown={function (e) { if (e.key === 'Enter') importUrl(); }} placeholder="https://…/book.epub 或 book.txt" />
            <button disabled={importing || !url.trim()} onClick={importUrl}>导入</button>
          </div>
        )}
        <div className="ls-book-rights">仅导入你拥有阅读权的文件，或公共领域与开放授权内容。</div>
        {status && <div className="ls-book-status" role="status">{status}</div>}
      </section>

      <div className="ls-book-section-head">
        <div><span>OUR SHELF</span><h3>在读的书</h3></div>
        <b>{books.length}</b>
      </div>

      {loading ? (
        <div className="ls-book-empty">正在翻书架…</div>
      ) : books.length ? (
        <div className="ls-book-grid">
          {books.map(function (book) {
            const pct = Math.max(0, Math.min(100, Number(book.progress_pct) || 0));
            return (
              <button className="ls-book-card" key={book.id} onClick={function () { onOpenBook(book); }}>
                <LSBookCover book={book} />
                <div className="ls-book-card-copy">
                  <div className="ls-book-format">{String(book.format || '').toUpperCase()}</div>
                  <h4>{book.title}</h4>
                  <p>{book.author || '佚名'}</p>
                  <div className="ls-book-card-meta">
                    <span>{lsBookCount(book.word_count)}</span>
                    <span>{Number(book.notes_count) || 0} 条批注</span>
                  </div>
                  <div className="ls-book-card-progress"><i style={{ width: pct + '%' }}></i></div>
                  <div className="ls-book-card-foot"><span>{pct ? ('读到 ' + pct.toFixed(pct < 10 ? 1 : 0) + '%') : '还没开始'}</span><b>{pct ? '继续读' : '打开'}</b></div>
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="ls-book-empty is-first">
          <div className="empty-mark">书</div>
          <h3>第一本书还在路上</h3>
          <p>从电脑或手机选择 TXT / EPUB；一次可以选很多本。PDF 会在排版和锚点足够可靠后再接进来。</p>
          <button onClick={function () { inputRef.current && inputRef.current.click(); }}>选择书籍</button>
        </div>
      )}
    </div>
  );
}

Object.assign(window, { LSShelfView, LSBookCover, lsBookApi });
