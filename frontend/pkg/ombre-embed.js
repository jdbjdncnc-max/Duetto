(function () {
  var params = new URLSearchParams(window.location.search || '');
  if (params.get('embed') !== 'ombre') return;

  var root = document.documentElement;
  root.classList.add('ombre-embed');
  window.__OMBRE_EMBED = true;

  function applyAccent(value) {
    var accent = String(value || '').trim();
    if (!/^#[0-9a-f]{6}$/i.test(accent)) return;
    root.style.setProperty('--ombre-accent', accent);
  }

  applyAccent(params.get('accent'));
  window.addEventListener('message', function (event) {
    var data = event && event.data;
    if (!data || data.type !== 'ombre:theme') return;
    applyAccent(data.accent);
  });

  function announceReady() {
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'duetto:ready' }, '*');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', announceReady, { once: true });
  } else {
    announceReady();
  }
})();
