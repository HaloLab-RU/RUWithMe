import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {CodexService,handleCodexRequest} from '../app/codex-service.mjs';

async function fixture(t,{contextBuilder=async()=>'',rpc}={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'ru-daily-interactions-'))),workspace=join(root,'workspace'),file=join(root,'.ruwithme/codex/session.json');
 for(const name of ['research','courses','learn','career','admin','personal','inbox'])await mkdir(join(workspace,name),{recursive:true});
 const calls=[],replies=[],service=new CodexService({workspaceRoot:workspace,projectRoot:root,sessionFile:file,contextBuilder,spawnProcess(){throw new Error('A unit test must never launch Codex.');}});
 service.ready=async()=>{};service.checkAccount=async()=>{};service.data.threadId='thread';service.attached=true;
 service.child={stdin:{write:raw=>{replies.push(JSON.parse(raw));return true;}},kill(){}};
 service.rpc=async(method,params)=>{calls.push({method,params});if(rpc)return rpc(method,params);if(method==='turn/start')return{turn:{id:'turn-a'}};if(method==='turn/steer')return{turnId:'turn-a'};if(method==='turn/interrupt')return{};throw new Error('Unexpected RPC: '+method);};
 t.after(async()=>{service.close();await service.writeQueue;await rm(root,{recursive:true,force:true});});
 return{root,workspace,file,service,calls,replies,event:(method,params={})=>service.receive({method,params:{threadId:'thread',turnId:'turn-a',...params}}),request:(id,method,params={})=>service.receive({id,method,params:{threadId:'thread',turnId:'turn-a',itemId:'item-'+id,cwd:root,startedAtMs:1,...params}})};
}

test('server-built context reaches the model without the former 3,000-character display cutoff',async t=>{
 const page='Canonical context '+'.'.repeat(6000)+' END_OF_CANONICAL_CONTEXT',browser=JSON.stringify({section:'courses',sourcePath:'courses/Fall/Example/README.md'});let received;
 const f=await fixture(t,{contextBuilder:async args=>{received=args;return page;}});
 await f.service.startTurn({text:'请帮我理解这门课',context:browser,requestId:'context-request'});
 assert.deepEqual(received,{workspaceRoot:f.workspace,context:browser});
 const call=f.calls.find(call=>call.method==='turn/start');assert.ok(call.params.input[0].text.includes(page));assert.ok(call.params.input[0].text.includes('END_OF_CANONICAL_CONTEXT'));assert.equal(call.params.clientUserMessageId,'context-request');
 assert.equal(f.service.data.messages[0].delivery,'sent');
});

test('context construction failure starts no turn, logs no submitted message and permits an explicit retry',async t=>{
 let fail=true;const f=await fixture(t,{contextBuilder:async()=>{if(fail)throw new Error('Cannot build current page context.');return'Current saved context';}}),input={text:'Keep this draft',context:'legacy selector',requestId:'context-failure'};
 await assert.rejects(f.service.startTurn(input),/Cannot build/);assert.equal(f.calls.length,0);assert.equal(f.service.active,null);assert.equal(f.service.data.messages.length,0);
 fail=false;await f.service.startTurn(input);assert.equal(f.calls.length,1);assert.equal(f.service.data.messages[0].text,input.text);
});

test('active-turn steering binds the expected turn, preserves independent user messages and deduplicates requests',async t=>{
 const f=await fixture(t);await f.service.startTurn({text:'Begin task',requestId:'begin'});
 const input={text:'Also use the second source',context:JSON.stringify({section:'inbox'}),requestId:'extra',expectedTurnId:'turn-a'};
 await Promise.all([f.service.steerTurn(input),f.service.steerTurn(input)]);
 const steers=f.calls.filter(c=>c.method==='turn/steer');assert.equal(steers.length,1);assert.equal(steers[0].params.expectedTurnId,'turn-a');assert.equal(steers[0].params.threadId,'thread');
 assert.deepEqual(f.service.data.messages.map(m=>m.text),['Begin task','Also use the second source']);assert.equal(f.service.data.messages[1].steeredTurnId,'turn-a');assert.equal(f.service.view().activeTurnId,'turn-a');
 await f.service.steerTurn(input);assert.equal(f.calls.filter(c=>c.method==='turn/steer').length,1);
 await assert.rejects(f.service.steerTurn({...input,requestId:'stale',expectedTurnId:'other-turn'}),e=>e.status===409);
 await assert.rejects(f.service.steerTurn({...input,text:'Different input with the same ID'}),e=>e.status===409);
});

test('a task finishing while steering context is built cannot receive late input',async t=>{
 let release;const wait=new Promise(resolve=>release=resolve);const f=await fixture(t,{contextBuilder:()=>wait});f.service.active={id:'turn-a'};
 const pending=f.service.steerTurn({text:'Late input',context:'{}',requestId:'late',expectedTurnId:'turn-a'});
 await new Promise(resolve=>setImmediate(resolve));f.service.active=null;release('Context');
 await assert.rejects(pending,e=>e.status===409);assert.equal(f.calls.length,0);assert.equal(f.service.data.messages.length,0);
});

test('rejected turn and steer inputs never become false-success replays and can be deliberately retried',async t=>{
 for(const kind of ['start','steer']){
  let attempts=0;const f=await fixture(t,{rpc:async()=>{attempts++;if(attempts===1)throw Object.assign(new Error('Codex rejected this input.'),{rpcRejected:true});return kind==='start'?{turn:{id:'turn-a'}}:{turnId:'turn-a'};}});
  if(kind==='steer')f.service.active={id:'turn-a'};
  const input={text:'Retry this exact draft',requestId:'retry-'+kind,expectedTurnId:'turn-a'},send=()=>kind==='start'?f.service.startTurn(input):f.service.steerTurn(input);
  await assert.rejects(send(),/rejected/);assert.equal(f.service.data.messages[0].delivery,'failed');assert.equal(attempts,1);
  await send();assert.equal(attempts,2);assert.equal(f.service.data.messages.length,1);assert.equal(f.service.data.messages[0].delivery,'sent');
  await send();assert.equal(attempts,2);
 }
});

test('uncertain RPC delivery keeps an explicit error and never silently replays or returns success',async t=>{
 for(const kind of ['start','steer']){
  let attempts=0;const f=await fixture(t,{rpc:async()=>{attempts++;throw Object.assign(new Error('Codex took too long to respond.'),{uncertain:true});}});
  if(kind==='steer')f.service.active={id:'turn-a'};
  const input={text:'Keep my uncertain draft',requestId:'unknown-'+kind,expectedTurnId:'turn-a'},send=()=>kind==='start'?f.service.startTurn(input):f.service.steerTurn(input);
  await assert.rejects(send(),e=>e.status===409&&/Delivery is uncertain/.test(e.message));assert.equal(f.service.data.messages[0].delivery,'unknown');
  await assert.rejects(send(),e=>e.status===409);assert.equal(attempts,1);assert.match(f.service.view().messages[0].deliveryError,/check the current Codex task/);
 }
});

test('trusted display labels remain separate from the actual submitted instruction and its replay identity',async t=>{
 const f=await fixture(t),input={text:'Detailed synthetic execution instruction',requestId:'trusted-label'};
 await f.service.startTurn(input,{displayText:'Publish the reviewed work block'});
 assert.equal(f.service.data.messages[0].text,'Publish the reviewed work block');assert.ok(f.calls[0].params.input[0].text.includes(input.text));
 await f.service.startTurn(input,{displayText:'Publish the reviewed work block'});assert.equal(f.calls.length,1);
});

test('an in-flight request ID cannot be reused with different text or bypass a pending interaction',async t=>{
 let release;const wait=new Promise(resolve=>release=resolve),f=await fixture(t,{contextBuilder:()=>wait});
 const first=f.service.startTurn({text:'Original pending input',requestId:'pending-id'});await new Promise(resolve=>setImmediate(resolve));
 await assert.rejects(f.service.startTurn({text:'A different pending input',requestId:'pending-id'}),e=>e.status===409);release('Context');await first;
 f.event('turn/completed',{turn:{id:'turn-a',status:'completed'}});f.request(111,'item/permissions/requestApproval',{permissions:{network:{enabled:true}}});
 await assert.rejects(f.service.startTurn({text:'New task',requestId:'new-task'}),e=>e.status===409&&/pending/.test(e.message));assert.equal(f.service.requests.size,1);
 f.service.answer({id:111,decision:'decline'});
});

test('tool traces retain bounded outputs, changes and failures while dropping opaque metadata and credentials',async t=>{
 const f=await fixture(t);f.service.active={id:'turn-a'};f.service.activityTurnId='turn-a';
 f.event('item/started',{item:{id:'command',type:'commandExecution',command:'node inspect.mjs',cwd:f.root,status:'inProgress'}});
 f.event('item/commandExecution/outputDelta',{itemId:'command',delta:'Normal note content\ncsrf='+f.service.csrf+'\naccess_token=ACCESS_VALUE\nrefresh_token=REFRESH_VALUE\napi_key=API_VALUE\nAuthorization: Bearer BEARER_VALUE\n'});
 f.event('item/completed',{item:{id:'command',type:'commandExecution',command:'node inspect.mjs',cwd:f.root,status:'failed',exitCode:1,durationMs:11}});
 f.event('item/completed',{item:{id:'files',type:'fileChange',status:'completed',changes:[{path:join(f.workspace,'inbox/note.md'),kind:{type:'update'},diff:'+ Normal notes\n+ password="PASSWORD_VALUE"'},{path:join(f.root,'.env'),kind:{type:'update'},diff:'+ SECRET_ENV_VALUE'}]}});
 f.event('item/mcpToolCall/progress',{itemId:'tool',message:'Fetching the selected calendar'});
 f.event('item/completed',{item:{id:'tool',type:'mcpToolCall',server:'codex_apps',tool:'example.read',status:'failed',arguments:{authorization:'ARGUMENT_SECRET'},_meta:{cookie:'META_SECRET'},error:{message:'Tool failed; csrf='+f.service.csrf},result:{content:[{type:'text',text:'Useful tool text; api_key=RESULT_SECRET'},{type:'image',data:'IMAGE_SECRET'}],structuredContent:{token:'OPAQUE_SECRET'},_meta:{secret:'RESULT_META_SECRET'}}}});
 f.event('item/completed',{item:{id:'web',type:'webSearch',query:'A useful reference',results:[{title:'Reference',url:'https://example.com/docs',secret:'WEB_META_SECRET'}]}});
 f.event('item/completed',{item:{id:'reason',type:'reasoning',summary:['PRIVATE_REASONING_SECRET']}});
 const trace=f.service.view().activity,serialized=JSON.stringify(trace);
 assert.ok(serialized.includes('Normal note content'));assert.ok(serialized.includes('Useful tool text'));assert.ok(serialized.includes('Reference'));assert.ok(serialized.includes('[redacted]'));assert.ok(serialized.includes('Sensitive file contents omitted'));
 for(const secret of [f.service.csrf,'ACCESS_VALUE','REFRESH_VALUE','API_VALUE','BEARER_VALUE','PASSWORD_VALUE','SECRET_ENV_VALUE','ARGUMENT_SECRET','META_SECRET','RESULT_SECRET','IMAGE_SECRET','OPAQUE_SECRET','RESULT_META_SECRET','WEB_META_SECRET','PRIVATE_REASONING_SECRET'])assert.ok(!serialized.includes(secret),'Unexpected sensitive trace value');
 assert.equal(trace.find(row=>row.id==='command').exitCode,1);assert.equal(trace.find(row=>row.id==='tool').status,'failed');assert.equal(trace.find(row=>row.id==='web').status,'completed');
 f.event('item/commandExecution/outputDelta',{itemId:'command',delta:'x'.repeat(30000)});assert.ok(f.service.activity.find(row=>row.id==='command').output.length<=12000);assert.equal(f.service.activity.find(row=>row.id==='command').truncated,true);
 f.event('item/completed',{item:{id:'large-diff',type:'fileChange',status:'completed',changes:[{path:join(f.workspace,'inbox/large.md'),kind:{type:'update'},diff:'+'.repeat(9000)}]}});assert.equal(f.service.activity.find(row=>row.id==='large-diff').truncated,true);
});

test('only the bounded latest activity projection persists across a restart without changing the Codex thread',async t=>{
 const f=await fixture(t);f.service.active={id:'turn-a'};f.service.activityTurnId='turn-a';
 for(let i=0;i<90;i++)f.event('item/completed',{item:{id:'tool-'+i,type:'commandExecution',command:'read note '+i,cwd:f.root,status:'completed',aggregatedOutput:'Plain output '+i+' '+'.'.repeat(15000)}});
 f.event('turn/completed',{turn:{id:'turn-a',status:'completed'}});await f.service.writeQueue;
 assert.ok(f.service.activity.length<=40);assert.ok(Buffer.byteLength(JSON.stringify(f.service.activity))<=384*1024);assert.equal(f.service.activityTruncated,true);
 const restored=new CodexService({workspaceRoot:f.workspace,projectRoot:f.root,sessionFile:f.file,spawnProcess(){throw new Error('No real process allowed.');}});await restored.load();
 assert.equal(restored.data.threadId,'thread');assert.deepEqual(restored.activity,f.service.activity);assert.equal(restored.activityTurnId,'turn-a');assert.equal(restored.activityTruncated,true);
 const saved=JSON.parse(await readFile(f.file,'utf8'));assert.ok(saved.activity.length<=40);assert.equal(saved.workspaceRoot,f.workspace);
});

test('requestUserInput preserves option descriptions and validates answers without saving secret responses',async t=>{
 const f=await fixture(t),questions=[{id:'choice',header:'Format',question:'Choose a format',isOther:false,isSecret:false,options:[{label:'Brief',description:'One short paragraph'},{label:'Detailed',description:'Include the supporting evidence'}]},{id:'other',header:'Other',question:'Anything else?',isOther:true,options:[{label:'None',description:'Continue'}]},{id:'secret',header:'Secret',question:'Enter the requested secret',isSecret:true,options:null}];
 f.request(10,'item/tool/requestUserInput',{questions,isBlocking:true});const pending=f.service.view().requests[0];assert.deepEqual(pending.questions,questions.map(q=>({isOther:false,isSecret:false,...q})));assert.equal(pending.isBlocking,true);
 assert.throws(()=>f.service.answer({id:10,answers:{}}),e=>e.status===400);
 const answers={choice:{answers:['Brief']},other:{answers:['A custom option']},secret:{answers:['SYNTHETIC_SECRET_ANSWER']}};
 assert.throws(()=>f.service.answer({id:10,answers:{...answers,choice:{answers:['Not offered']}}}),e=>e.status===400);
 assert.throws(()=>f.service.answer({id:10,answers:{...answers,secret:{answers:[]}}}),e=>e.status===400);
 f.service.answer({id:10,answers});assert.deepEqual(f.replies[0],{id:10,result:{answers}});assert.equal(f.service.requests.size,0);assert.ok(!JSON.stringify(f.service.view()).includes('SYNTHETIC_SECRET_ANSWER'));
});

test('project filesystem and network permissions require an explicit turn-scoped approval',async t=>{
 const f=await fixture(t),permissions={fileSystem:{read:[join(f.workspace,'inbox/note.md')],entries:[{access:'write',path:{type:'path',path:join(f.root,'app/new.mjs')}}]},network:{enabled:true}};
 f.request(20,'item/permissions/requestApproval',{permissions,reason:'Read the requested source and access the network'});
 assert.equal(f.replies.length,0);assert.equal(f.service.requests.get('20').canApprove,true);assert.deepEqual(f.service.requests.get('20').permissions,permissions);
 f.service.answer({id:20,decision:'accept'});assert.deepEqual(f.replies[0],{id:20,result:{permissions,scope:'turn'}});
 f.request(21,'item/permissions/requestApproval',{permissions:{network:{enabled:true}}});f.service.answer({id:21,decision:'decline'});assert.deepEqual(f.replies[1],{id:21,result:{permissions:{},scope:'turn'}});
 assert.throws(()=>f.service.answer({id:21,decision:'accept'}),e=>e.status===409);
});

test('out-of-project, symlink, glob and unsupported permissions are visible errors and cannot be granted',async t=>{
 const f=await fixture(t),outside=await realpath(await mkdtemp(join(tmpdir(),'ru-daily-outside-')));t.after(()=>rm(outside,{recursive:true,force:true}));await symlink(outside,join(f.root,'escape'));
 const profiles=[{fileSystem:{write:[outside]}},{fileSystem:{read:[join(f.root,'escape/private.txt')]}},{fileSystem:{entries:[{access:'write',path:{type:'glob_pattern',pattern:'/**'}}]}},{fileSystem:{entries:[{access:'write',path:{type:'special',value:{kind:'root'}}}]}},{network:{enabled:true,domains:['example.com']}},{unknown:true}];
 for(let i=0;i<profiles.length;i++){
  const id=30+i;f.request(id,'item/permissions/requestApproval',{permissions:profiles[i]});const request=f.service.requests.get(String(id));assert.equal(request.canApprove,false);assert.ok(request.unsupportedReason);
  const before=f.replies.length;assert.throws(()=>f.service.answer({id,decision:'accept'}),e=>e.status===400);assert.equal(f.replies.length,before);f.service.answer({id,decision:'decline'});assert.equal(f.replies.at(-1).error.code,-32602);
 }
 f.request(99,'unsupported/privateMethod',{arguments:{token:'DO_NOT_DUMP'}});assert.equal(f.replies.at(-1).error.code,-32601);assert.ok(f.service.activity.some(item=>item.type==='interaction'&&item.error.includes('not supported')));assert.ok(!JSON.stringify(f.service.activity).includes('DO_NOT_DUMP'));
});

test('HTTP steering keeps origin and CSRF gates and returns failures without claiming input delivery',async t=>{
 const f=await fixture(t);f.service.active={id:'turn-a'};let origin;
 const server=http.createServer((req,res)=>handleCodexRequest(req,res,{service:f.service,origin}));server.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const send=(body,headers={})=>fetch(origin+'/api/codex/steer',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-RUWithMe-CSRF':f.service.csrf,...headers},body:JSON.stringify(body)});
 for(const headers of [{Origin:'https://example.com'},{'X-RUWithMe-CSRF':'wrong'}]){const response=await send({text:'Blocked',requestId:'blocked'},headers);assert.equal(response.status,403);await response.json();}assert.equal(f.calls.length,0);
 const response=await send({text:'Use this source too',requestId:'http-steer',expectedTurnId:'turn-a'});assert.equal(response.status,200);const view=await response.json();assert.equal(view.messages.at(-1).delivery,'sent');assert.equal(f.calls[0].method,'turn/steer');
 f.service.rpc=async()=>{throw Object.assign(new Error('Explicit rejection'),{rpcRejected:true});};
 const failed=await send({text:'Keep this draft',requestId:'failed-steer',expectedTurnId:'turn-a'});assert.equal(failed.status,503);assert.match((await failed.json()).error,/rejection/);
 const retry=await send({text:'Keep this draft',requestId:'failed-steer',expectedTurnId:'turn-a'});assert.equal(retry.status,503);await retry.json();
});
