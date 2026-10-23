import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,mkdir,writeFile,readFile,realpath,symlink,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join,dirname} from 'node:path';
import {CodexService} from '../app/codex-service.mjs';

function mocked(options={}){
 const calls=[],service=new CodexService({workspaceRoot:'/mock/project/workspace',projectRoot:'/mock/project',sessionFile:'/mock/session.json',spawnProcess(){throw new Error('Do not start a real Codex process in a scope test.');},...options});
 service.ready=async()=>{};service.save=async()=>{};
 service.rpc=async(method,params)=>{
  calls.push({method,params});
  if(method==='thread/start'||method==='thread/resume')return{thread:{id:params.threadId||'new-test-thread'},model:'reported-model'};
  throw new Error('No inference turn is permitted in this scope test.');
 };
 return{service,calls};
}
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'ru-codex-scope-'))),workspace=join(root,'workspace');await mkdir(workspace);
 t.after(()=>rm(root,{recursive:true,force:true}));return{root,workspace};
}

test('new and resumed threads use the project cwd while content context and APIs stay content-relative',async()=>{
 for(const resume of [false,true]){
  const {service,calls}=mocked({appOrigin:'http://127.0.0.1:4191'});
  if(resume)service.data.threadId='existing-test-thread';
  await service.ensureThread();
  assert.equal(calls.length,1);assert.equal(calls[0].method,resume?'thread/resume':'thread/start');
  const params=calls[0].params;
  assert.equal(params.cwd,'/mock/project');assert.equal(params.sandbox,'workspace-write');assert.equal(params.approvalPolicy,'on-request');assert.equal(params.approvalsReviewer,'user');
  if(resume){assert.equal(params.threadId,'existing-test-thread');assert.equal(params.excludeTurns,true);}
  const prompt=params.developerInstructions;
  assert.ok(prompt.includes('The content root is /mock/project/workspace.'));
  assert.ok(prompt.includes('Set the command working directory to /mock/project/workspace'));
  assert.ok(prompt.includes('sourcePath page context is also relative to this content root'));
  assert.ok(prompt.includes('/mock/project/RECORDS.md'));
  assert.ok(prompt.includes('do not create sibling research/, courses/, inbox/ or records/ folders at the project root'));
  assert.ok(prompt.includes('edit application code, project documentation and user content inside this project when requested'));
  assert.ok(prompt.includes('use revision-checked local APIs'));assert.ok(prompt.includes('manual browser snapshots'));assert.ok(prompt.includes('not a live Canvas connection'));
  assert.ok(!prompt.includes('Do not edit the parent app/'));assert.ok(!prompt.includes('Build is a separate developer conversation'));assert.ok(!prompt.includes('../RECORDS.md'));assert.ok(!prompt.includes(service.csrf));
  const view=service.view();assert.equal(view.workspaceRoot,'/mock/project/workspace');assert.equal(view.projectRoot,'/mock/project');
  assert.deepEqual(view.access,{mode:'project-write',writableRoot:'/mock/project',approvalPolicy:'on-request'});assert.equal(view.model,'reported-model');
 }
});

test('omitting projectRoot preserves the former content cwd and reports the narrower configured scope',async()=>{
 const {service,calls}=mocked({projectRoot:undefined});await service.ensureThread();
 assert.equal(calls[0].params.cwd,'/mock/project/workspace');
 assert.equal(service.projectRoot,service.workspaceRoot);assert.equal(service.executionRoot,service.workspaceRoot);
 assert.deepEqual(service.view().access,{mode:'workspace-write',writableRoot:'/mock/project/workspace',approvalPolicy:'on-request'});
 assert.ok(calls[0].params.developerInstructions.includes('Content subfolders belong directly inside this content root.'));
 assert.ok(!calls[0].params.developerInstructions.includes('do not create sibling research/'));
 assert.ok(calls[0].params.developerInstructions.includes('/mock/project/RECORDS.md'));
});

test('the spawned app-server cwd changes without starting a model or changing authentication configuration',async t=>{
 const child=new EventEmitter();child.stdout=new PassThrough();child.stdin=new PassThrough();child.kill=()=>child.emit('exit',0);
 let captured;
 const service=new CodexService({workspaceRoot:'/mock/project/workspace',projectRoot:'/mock/project',sessionFile:'/mock/session',spawnProcess:(bin,args,options)=>{captured={bin,args,cwd:options.cwd};return child;}});
 t.after(()=>{service.close();child.stdout.destroy();child.stdin.destroy();});
 service.rpc=async method=>{assert.equal(method,'initialize');return{};};service.checkAccount=async()=>{};
 await service.start();
 assert.equal(captured.cwd,'/mock/project');assert.ok(captured.args.includes('app-server'));assert.ok(captured.args.includes('forced_login_method="chatgpt"'));assert.ok(!captured.args.some(arg=>arg.includes('danger-full-access')));
});

test('Daily installs its local stdio record tools for new and resumed sessions without widening the command sandbox',async t=>{
 const child=new EventEmitter();child.stdout=new PassThrough();child.stdin=new PassThrough();child.kill=()=>child.emit('exit',0);let captured;
 const {service,calls}=mocked({appOrigin:'http://127.0.0.1:4191',spawnProcess:(bin,args,options)=>{captured={args,options};return child;}});
 t.after(()=>{service.close();child.stdout.destroy();child.stdin.destroy();});
 const rpc=service.rpc;service.rpc=async(method,params)=>method==='initialize'?{}:rpc(method,params);service.checkAccount=async()=>{};
 await service.start();assert.ok(captured.args.some(a=>a.startsWith('mcp_servers.ruwithme_daily.command=')));assert.ok(captured.args.some(a=>a.includes('daily-records-mcp.mjs')&&a.includes('http://127.0.0.1:4191')));
 assert.ok(!captured.args.some(a=>a.includes('network_access=true')||a.includes('danger-full-access')));
 for(const resumed of [false,true]){service.attached=false;service.data.threadId=resumed?'existing-thread':null;await service.ensureThread();const call=calls.at(-1);assert.equal(call.params.sandbox,'workspace-write');assert.ok(call.params.developerInstructions.includes('ruwithme_daily MCP tools'));}
});

test('project scope resumes and preserves a legacy saved session keyed by its content workspace',async t=>{
 const {root,workspace}=await fixture(t),sessionFile=join(root,'.ruwithme/codex/session.json');await mkdir(dirname(sessionFile),{recursive:true});
 const example={threadId:'existing-synthetic-thread',model:'old-reported-model',messages:[{id:'synthetic-message',role:'user',text:'Synthetic test history'}],workspaceRoot:workspace,active:false};
 await writeFile(sessionFile,JSON.stringify(example));
 const service=new CodexService({workspaceRoot:workspace,projectRoot:root,sessionFile,spawnProcess(){throw new Error('No real process allowed.');}}),calls=[];
 service.ready=()=>service.load();
 service.rpc=async(method,params)=>{calls.push({method,params});assert.equal(method,'thread/resume');return{thread:{id:params.threadId},model:'current-reported-model'};};
 await service.ensureThread();
 assert.equal(calls.length,1);assert.equal(calls[0].params.threadId,example.threadId);assert.equal(calls[0].params.cwd,root);
 assert.equal(service.workspaceRoot,workspace);assert.deepEqual(service.data.messages,example.messages);
 const saved=JSON.parse(await readFile(sessionFile,'utf8'));assert.equal(saved.threadId,example.threadId);assert.equal(saved.workspaceRoot,workspace);assert.deepEqual(saved.messages,example.messages);assert.equal(saved.model,'current-reported-model');
});

test('project scope rejects filesystem/home roots, unrelated content and symlink escapes',async t=>{
 for(const projectRoot of ['',null,42,'.','/','/mock/elsewhere',homedir(),dirname(homedir())])assert.throws(()=>mocked({projectRoot}),/project directory/);
 assert.throws(()=>mocked({workspaceRoot:'/mock/project-other/workspace'}),/project directory/);
 const {root}=await fixture(t),outside=await realpath(await mkdtemp(join(tmpdir(),'ru-codex-scope-outside-')));t.after(()=>rm(outside,{recursive:true,force:true}));
 await symlink(outside,join(root,'redirected'));
 assert.throws(()=>new CodexService({workspaceRoot:join(root,'redirected'),projectRoot:root,sessionFile:join(root,'session')}),/project directory/);
 const file=join(root,'file');await writeFile(file,'not a directory');
 assert.throws(()=>new CodexService({workspaceRoot:join(file,'workspace'),projectRoot:file,sessionFile:join(root,'session')}),/directories/);
});
