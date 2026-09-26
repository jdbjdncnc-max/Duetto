import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
let listener,sent;
const parent={postMessage:(body,origin)=>{sent={body,origin};}};
const sandbox={URLSearchParams,Map,Promise,Error,String,crypto:{randomUUID:()=>"request-one"},setTimeout:()=>1,clearTimeout:()=>{},setInterval:()=>1,
 document:{documentElement:{classList:{add(){}},style:{setProperty(){}}},readyState:'loading',addEventListener(){}},
 window:{parent,location:{search:'?embed=ombre'},addEventListener:(_,fn)=>listener=fn}};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(new URL('../frontend/pkg/ombre-embed.js',import.meta.url),'utf8'),sandbox);
await assert.rejects(sandbox.window.__ombreBookChat({}),/更新/);
listener({source:parent,origin:'https://host.example',data:{type:'ombre:theme',bookChat:true}});
const pending=sandbox.window.__ombreBookChat({prompt:'看这句',ai:{api_key:'must-not-cross'},nowReading:{quote:'书句'}});
assert.equal(sent.origin,'https://host.example');
assert.ok(!JSON.stringify(sent).includes('must-not-cross'));
listener({source:parent,origin:'https://wrong.example',data:{type:'ombre:book-chat-result',id:'request-one',error:'wrong'}});
listener({source:parent,origin:'https://host.example',data:{type:'ombre:book-chat-result',id:'request-one',result:{reply:'收到'}}});
assert.equal((await pending).reply,'收到');
console.log('reading bridge handshake, credential isolation and reply origin passed');

// Exercise long-press cancellation using the real JSX component and fake clock.
const babel={};vm.createContext(babel);
vm.runInContext(fs.readFileSync(new URL('../frontend/pkg/vendor/babel.js',import.meta.url),'utf8'),babel);
const reader=fs.readFileSync(new URL('../frontend/pkg/listen/reader.jsx',import.meta.url),'utf8');
const component=reader.slice(reader.indexOf('function LSParagraphHandle'),reader.indexOf('function LSReaderView'));
let timer,cleanup,selected=0;
const gesture={React:{createElement:(_tag,props)=>props},rUseRef:()=>({current:null}),rUseEffect:fn=>cleanup=fn(),Math,
 setTimeout:fn=>{timer=fn;return 1;},clearTimeout:()=>{timer=null;}};
vm.createContext(gesture);
vm.runInContext(babel.Babel.transform(component,{presets:[['react',{runtime:'classic'}]]}).code,gesture);
const handle=gesture.LSParagraphHandle({block:{idx:1},onSelect:()=>selected++});
handle.onPointerDown({clientX:0,clientY:0});handle.onPointerMove({clientX:0,clientY:20});assert.equal(timer,null);
handle.onPointerDown({clientX:0,clientY:0});handle.onPointerCancel();assert.equal(timer,null);
handle.onPointerDown({clientX:0,clientY:0});timer();assert.equal(selected,1);
handle.onPointerDown({clientX:0,clientY:0});cleanup();assert.equal(timer,null);
console.log('paragraph hold selects once, scrolling/cancel/unmount cancel pending selection');


// Synchronization paginates old notes before remembering, and retries failures.
let receiver, fail=false, syncCalls=0, rememberedCalls=0, rpcId=0;
const synced=[];
const host={postMessage(message){
  if(message.type==='duetto:ready')return;
  queueMicrotask(()=>{
    const error=fail?'offline':undefined;
    if(message.payload.action==='remember') rememberedCalls++;
    else {syncCalls++;if(!error)synced.push(...message.payload.records);}
    receiver({source:host,origin:'https://host.example',data:{type:'ombre:book-chat-result',id:message.id,error,result:{ok:true,memory_id:'saved'}}});
  });
}};
const syncSandbox={URLSearchParams,Map,Promise,Error,String,crypto:{randomUUID:()=>String(++rpcId)},setTimeout:()=>1,clearTimeout(){},setInterval(){},
 CustomEvent:function(type,options){this.type=type;this.detail=options.detail;},
 document:{documentElement:{classList:{add(){}},style:{setProperty(){}}},readyState:'loading',addEventListener(){}},
 fetch:async url=>({ok:true,json:async()=>url.endsWith('after=0')?{ok:true,records:[{id:1}],next:1}:{ok:true,records:[{id:2}],next:null}}),
 window:{parent:host,location:{search:'?embed=ombre'},addEventListener:(name,fn)=>{if(name==='message')receiver=fn;},dispatchEvent(){}}};
vm.createContext(syncSandbox);
vm.runInContext(fs.readFileSync(new URL('../frontend/pkg/ombre-embed.js',import.meta.url),'utf8'),syncSandbox);
receiver({source:host,origin:'https://host.example',data:{type:'ombre:theme',bookChat:true,readingRecords:true}});
await syncSandbox.window.__ombreSyncReading();
assert.ok(syncCalls>=2);assert.deepEqual([...new Set(synced.map(n=>n.id))],[1,2]);
fail=true;await assert.rejects(syncSandbox.window.__ombreRememberReading('book',1,true),/offline/);
assert.equal(rememberedCalls,0);
fail=false;assert.equal((await syncSandbox.window.__ombreRememberReading('book',1,true)).memory_id,'saved');
assert.equal(rememberedCalls,1);
console.log('archive pagination, sync-before-remember and offline retry passed');
