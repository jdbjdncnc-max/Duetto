import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
let listener,sent;
const parent={postMessage:(body,origin)=>{sent={body,origin};}};
const sandbox={URLSearchParams,Map,Promise,Error,String,crypto:{randomUUID:()=>"request-one"},setTimeout:()=>1,clearTimeout:()=>{},
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

