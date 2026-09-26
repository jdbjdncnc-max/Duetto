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

  var parentOrigin = '', requests = new Map();
  window.__ombreBookChat = function (payload) {
    if (!parentOrigin) return Promise.reject(new Error('请先更新 Entangle 应用，再使用内嵌共读。'));
    return new Promise(function(resolve,reject){
      var id=crypto.randomUUID();
      var timer=setTimeout(function(){requests.delete(id);reject(new Error('共读回复超时，请重试。'));},120000);
      requests.set(id,{resolve:resolve,reject:reject,timer:timer});
      // Connection secrets stay in Entangle; only reading material crosses the frame boundary.
      var content={prompt:payload.prompt,history:payload.history,nowReading:payload.nowReading,readingReview:payload.readingReview};
      window.parent.postMessage({type:'duetto:book-chat',id:id,payload:content},parentOrigin);
    });
  };
  applyAccent(params.get('accent'));
  window.addEventListener('message', function (event) {
    var data = event && event.data;
    if (event.source !== window.parent || !data) return;
    if (data.type === 'ombre:book-chat-result' && event.origin === parentOrigin) {
      var request=requests.get(data.id); if(!request)return;
      clearTimeout(request.timer); requests.delete(data.id);
      if(data.error)request.reject(new Error(data.error)); else request.resolve(data.result);
      return;
    }
    if (data.type !== 'ombre:theme') return;
    if(data.bookChat === true)parentOrigin=event.origin;
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
