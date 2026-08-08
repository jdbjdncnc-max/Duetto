import crypto from 'node:crypto';


export function deriveOmbreEventUrl(ai) {
  const explicit = String((ai && ai.event_url) || '').trim();
  if (/^https:\/\//i.test(explicit)) return explicit;
  const contextUrl = String((ai && ai.context_url) || '').trim();
  if (!/^https:\/\//i.test(contextUrl)) return '';
  try {
    const url = new URL(contextUrl);
    if (!/\/api\/duetto\/context\/?$/.test(url.pathname)) return '';
    url.pathname = url.pathname.replace(/\/context\/?$/, '/events');
    return url.toString();
  } catch (_e) {
    return '';
  }
}


export function createOmbreEventBridge({
  db,
  getSettings,
  assertPublicUrl,
  fetchT,
  source = 'urn:duetto:self-hosted',
  log = console,
}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ombre_event_outbox(
      id TEXT PRIMARY KEY,
      event_json TEXT NOT NULL,
      attempts INTEGER DEFAULT 0,
      next_attempt_at INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ombre_event_due ON ombre_event_outbox(next_attempt_at, created_at);
  `);

  let flushing = null;
  let timer = null;

  function scheduleFlush() {
    void flush().catch(error => {
      if (log && typeof log.warn === 'function') {
        log.warn('[Duetto -> Ombre] event bridge unavailable:', String(error && error.message || error));
      }
    });
  }

  function queue({ id = '', type = '', subject = '', time = '', data = {} } = {}) {
    const eventId = String(id || crypto.randomUUID()).slice(0, 160);
    const eventType = String(type || '').slice(0, 120);
    if (!eventType) return null;
    const now = Date.now();
    const event = {
      specversion: '1.0',
      id: eventId,
      source: String(source || 'urn:duetto:self-hosted').slice(0, 240),
      type: eventType,
      subject: String(subject || '').slice(0, 300),
      time: time || new Date(now).toISOString(),
      datacontenttype: 'application/json',
      data: data && typeof data === 'object' ? data : {},
    };
    db.prepare(`INSERT OR IGNORE INTO ombre_event_outbox(id,event_json,attempts,next_attempt_at,created_at)
      VALUES(?,?,0,0,?)`).run(eventId, JSON.stringify(event), now);
    scheduleFlush();
    return event;
  }

  async function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      const settings = getSettings();
      const ai = (settings && settings.ai) || {};
      const url = deriveOmbreEventUrl(ai);
      if (!url) return { delivered: 0, pending: pendingCount() };
      const rows = db.prepare(`SELECT id,event_json,attempts FROM ombre_event_outbox
        WHERE next_attempt_at<=? ORDER BY created_at LIMIT 20`).all(Date.now());
      if (!rows.length) return { delivered: 0, pending: pendingCount() };
      await assertPublicUrl(url);
      const headers = { 'Content-Type': 'application/cloudevents+json' };
      const key = String(ai.context_key || '').trim();
      if (key) headers.Authorization = 'Bearer ' + key;
      let delivered = 0;
      for (const row of rows) {
        try {
          const response = await fetchT(url, {
            method: 'POST',
            headers,
            body: row.event_json,
          }, 70000);
          if (!response.ok) throw new Error('HTTP ' + response.status);
          db.prepare('DELETE FROM ombre_event_outbox WHERE id=?').run(row.id);
          delivered += 1;
        } catch (error) {
          const attempts = Math.max(0, Number(row.attempts) || 0) + 1;
          const delay = Math.min(10 * 60 * 1000, 5000 * Math.pow(2, Math.min(7, attempts - 1)));
          db.prepare('UPDATE ombre_event_outbox SET attempts=?,next_attempt_at=? WHERE id=?')
            .run(attempts, Date.now() + delay, row.id);
          if (log && typeof log.warn === 'function') {
            log.warn('[Duetto -> Ombre] event delivery deferred:', String(error && error.message || error));
          }
        }
      }
      return { delivered, pending: pendingCount() };
    })();
    try {
      return await flushing;
    } finally {
      flushing = null;
    }
  }

  function pendingCount() {
    const row = db.prepare('SELECT COUNT(*) AS n FROM ombre_event_outbox').get();
    return Number(row && row.n) || 0;
  }

  function start() {
    if (timer) return;
    timer = setInterval(scheduleFlush, 30000);
    if (timer && typeof timer.unref === 'function') timer.unref();
    scheduleFlush();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { queue, flush, pendingCount, start, stop };
}
