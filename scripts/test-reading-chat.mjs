import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../server/index.mjs',import.meta.url),'utf8');
const start=source.indexOf("app.post('/api/chat',");
const end=source.indexOf("\n",start);
let handler, sent, response;
const sandbox={console, process, JSON, String, Array,
  app:{post:(_path,fn)=>{handler=fn;}}, getSettings:()=>({ai:{api_key:'fake'}}), mergeAi:x=>x,
  bookService:{enrichReading:np=>{np.title='测试书';np.chapter=2;np.paragraph_offset=3;}},
  enrichNp:async()=>{}, fetchContext:async()=>({text:'',recallInjected:false}),
  sysPrompt:(_s,_kind,np)=>JSON.stringify(np),
  callLLMResult:async(_s,messages)=>{sent=messages;return {text:'["真实回复 [[emotion:🙂]]"]',model:'test'};},
  stripThinking:x=>({text:x,think:''}),deStar:x=>x,parseReplies:JSON.parse,logRoomNote:()=>{throw Error('reading must not log music');}
};
vm.runInNewContext(source.slice(start,end),sandbox);
const res={status(code){this.code=code;return this;},json(value){response=value;}};
await handler({body:{kind:'book',prompt:'这一句怎么看',history:[],nowReading:{id:'one',block_idx:4,quote:'选中的句子',mode:'selection'}}},res);
assert.equal(response.reply,'真实回复');assert.equal(response.emotion,'🙂');
assert.equal(JSON.parse(sent[0].content).paragraph_offset,3);
await handler({body:{kind:'book',prompt:'回顾',nowReading:{id:'one',mode:'review'},readingReview:[{chapter:2,author:'eve',text:'我的想法',emotions:[{actor:'eve',emoji:'😭'}]}]}},res);
assert.ok(sent[0].content.includes('我的想法'));assert.ok(sent[0].content.includes('😭'));
await handler({body:{kind:'book',prompt:'回顾',nowReading:{id:'one',mode:'review'},readingReview:[{text:'x'.repeat(100001)}]}},res);
assert.equal(res.code,413);
console.log('reading chat excerpt, review context, emoji extraction and size limits passed');
