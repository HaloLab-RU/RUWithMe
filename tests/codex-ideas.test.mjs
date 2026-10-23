import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CodexService} from '../app/codex-service.mjs';

function mockService(options={}){
 const calls=[],service=new CodexService({workspaceRoot:'/mock/workspace',sessionFile:'/mock/session.json',spawnProcess(){throw new Error('A test must not start Codex.');},...options});
 service.ready=async()=>{};service.checkAccount=async()=>{};service.save=async()=>{};
 service.rpc=async(method,params)=>{
  calls.push({method,params});
  if(method==='thread/start'||method==='thread/resume')return{thread:{id:'mock-thread'},model:'mock-model'};
  if(method==='turn/start')return{turn:{id:'mock-turn'}};
  throw new Error('Unexpected RPC: '+method);
 };
 return{service,calls};
}

test('new and resumed Daily threads receive the configured local Ideas API contract without credentials',async()=>{
 for(const resume of [false,true]){
  const origin='http://127.0.0.1:49123',{service,calls}=mockService({appOrigin:origin});
  if(resume)service.data.threadId='saved-thread';
  await service.startTurn({text:'记录一个想法',requestId:'mock-request'});
  assert.equal(calls[0].method,resume?'thread/resume':'thread/start');
  const text=calls[0].params.developerInstructions;
  assert.ok(text.includes('inbox/.ideas.json'));
  assert.ok(text.includes('Do not write this JSON file directly'));
  assert.ok(text.includes('Existing Markdown and other original source files remain in Files & links'));
  assert.ok(text.includes('GET '+origin+'/api/workspace'));
  assert.ok(text.includes('GET '+origin+'/api/codex/session'));
  assert.ok(text.includes('Origin: '+origin));
  assert.ok(text.includes('X-RUWithMe-CSRF'));
  assert.ok(text.includes('POST '+origin+'/api/inbox/ideas and {text}'));
  assert.ok(text.includes('POST '+origin+'/api/inbox/ideas/update and {id,text,expectedRevision}'));
  assert.ok(text.includes('never silently retry with a newer revision'));
  assert.ok(!text.includes(service.csrf));
  assert.equal(calls[1].method,'turn/start');
 }
});

test('a Daily instance without an app origin directs Ideas writes to the UI without inventing an origin',async()=>{
 const {service,calls}=mockService();
 await service.startTurn({text:'记录一个想法',requestId:'mock-request'});
 const text=calls[0].params.developerInstructions;
 assert.equal(service.appOrigin,null);
 assert.ok(text.includes('No local app origin is configured'));
 assert.ok(text.includes('Inbox → Ideas'));
 assert.ok(!text.includes('/api/codex/session'));
 assert.ok(!text.includes('http://'));
});

test('Daily API origins accept local HTTP origins and reject remote or non-origin values',()=>{
 assert.equal(mockService({appOrigin:'http://localhost:4191/'}).service.appOrigin,'http://localhost:4191');
 for(const appOrigin of [null,42,'','http://localhost','https://localhost:4191','http://example.com:4191','http://127.0.0.1:4191/path','http://127.0.0.1:4191/?x=1','http://127.0.0.1:4191/#fragment','http://user:secret@127.0.0.1:4191'])assert.throws(()=>mockService({appOrigin}),/local HTTP app origin/);
});
