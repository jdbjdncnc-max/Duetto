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
  function hostRequest(type, content) {
    if (!parentOrigin) return Promise.reject(new Error('请先更新 Entangle 应用，再使用内嵌共读。'));
    return new Promise(function(resolve,reject){
      var id=crypto.randomUUID();
      var timer=setTimeout(function(){requests.delete(id);reject(new Error('共读回复超时，请重试。'));},120000);
      requests.set(id,{resolve:resolve,reject:reject,timer:timer});
      // Connection secrets stay in Entangle; only reading material crosses the frame boundary.
      window.parent.postMessage({type:type,id:id,payload:content},parentOrigin);
    });
  };
  window.__ombreBookChat = function(payload) {
    return hostRequest('duetto:book-chat',{prompt:payload.prompt,history:payload.history,nowReading:payload.nowReading,readingReview:payload.readingReview});
  };
  var syncQueue=Promise.resolve(), syncReady=false, dirty=true;
  function syncStatus(text) {
    window.__ombreReadingSyncStatus=text;
    window.dispatchEvent(new CustomEvent('ombre:reading-sync',{detail:text}));
  }
  window.__ombreSyncReading = function() {
    dirty=true;
    syncQueue=syncQueue.catch(function(){}).then(async function(){
      if(!syncReady)throw new Error('请先更新 Entangle 应用和服务端，再同步共读。');
      syncStatus('正在同步共读记录…');
      try {
        var after=0;
        do {
          var response=await fetch((window.__LS_API||'/api')+'/reading-export?after='+after);
          var page=await response.json();
          if(!response.ok || !page.ok)throw new Error(page.error||'共读记录读取失败');
          await hostRequest('duetto:reading-records',{records:page.records});
          after=page.next;
        } while(after!==null);
        dirty=false;syncStatus('共读记录已同步到对话');
      } catch(error) {syncStatus('共读暂未同步，联网后重试');throw error;}
    });
    return syncQueue;
  };
  window.__ombreRememberReading = async function(bookId,noteId,remember) {
    await window.__ombreSyncReading();
    return hostRequest('duetto:reading-records',{action:'remember',book_id:bookId,note_id:String(noteId),remember:remember});
  };
  function retrySync() {if(syncReady && dirty)window.__ombreSyncReading().catch(function(){});}
  window.addEventListener('online',retrySync);
  setInterval(retrySync,30000);
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
    if(data.readingRecords===true && !syncReady){syncReady=true;retrySync();}
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
