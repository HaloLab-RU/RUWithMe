import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {once} from 'node:events';
import {TodoService,zonedInstant} from '../app/todos.mjs';
import {emptyCalendar,emptyCommitments,readRecords} from '../app/records.mjs';
import {createRequestHandler} from '../app/server.mjs';
const fixed=()=>new Date('2026-10-21T02:00:00Z');
async function fixture(t){const root=await realpath(await mkdtemp(join(tmpdir(),'ru-todos-'))),workspace=join(root,'workspace');for(const dir of ['inbox','research/project','courses','learn','records/days'])await mkdir(join(workspace,dir),{recursive:true});await writeFile(join(workspace,'research/project/README.md'),'# Project');await writeFile(join(workspace,'inbox/original.txt'),'Keep original');await writeFile(join(workspace,'records/commitments.json'),JSON.stringify(emptyCommitments()));const calendar=emptyCalendar();calendar.events.push({id:'keep',title:'Existing event',status:'confirmed',allDay:true,startDate:'2026-10-20',endDate:'2026-10-21',timeZone:'America/New_York'});await writeFile(join(workspace,'records/calendar.json'),JSON.stringify(calendar));t.after(()=>rm(root,{recursive:true,force:true}));return{root,workspace,service:new TodoService({workspace,now:fixed})};}
async function create(service,extra={}){return service.create({requestId:randomUUID(),title:'Read paper A',category:'research',ownerPath:'research/project/README.md',dueDate:'2026-10-23',expectedRevision:0,...extra});}
async function schedule(service,id,extra={}){return service.schedule({id,requestId:randomUUID(),expectedRevision:1,expectedCalendarRevision:0,startLocal:'2026-10-21T10:00',endLocal:'2026-10-21T11:00',...extra});}
test('Todo → Today → scheduled work → completion and reopen survive reads without altering deadlines or existing sources',async t=>{
 const {workspace,service}=await fixture(t),task=await create(service,{addToToday:true});assert.deepEqual(task.todayDates,['2026-10-20']);assert.equal(task.status,'open');const block=await schedule(service,task.id);
 assert.equal(block.commitmentId,task.id);assert.equal(block.startAt,'2026-10-21T14:00:00.000Z');
 await service.complete({id:task.id,done:true,expectedRevision:1});let records=await readRecords(workspace);assert.equal(records.commitments.items[0].completedAt,fixed().toISOString());assert.equal(records.commitments.items[0].dueDate,'2026-10-23');assert.equal(records.calendar.workBlocks[0].status,'planned');assert.equal(records.calendar.events[0].id,'keep');assert.deepEqual(records.days,[]);
 const restarted=new TodoService({workspace,now:fixed});await restarted.complete({id:task.id,done:false,expectedRevision:2});records=await readRecords(workspace);assert.equal(records.commitments.items[0].status,'open');assert.deepEqual(records.commitments.items[0].history.map(e=>e.action),['completed','reopened']);assert.equal(records.commitments.items[0].completedAt,null);assert.equal(await readFile(join(workspace,'inbox/original.txt'),'utf8'),'Keep original');
 await restarted.today({id:task.id,selected:false,expectedRevision:3});assert.deepEqual((await readRecords(workspace)).commitments.items[0].todayDates,[]);
});
test('revision conflicts and concurrent edits preserve the winning Todo and caller drafts',async t=>{
 const {workspace,service}=await fixture(t),task=await create(service);
 const results=await Promise.allSettled(['One','Two'].map(title=>service.update({id:task.id,title,category:'learn',expectedRevision:1})));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
 const before=await readFile(join(workspace,'records/commitments.json'),'utf8');await assert.rejects(service.complete({id:task.id,done:true,expectedRevision:1}),e=>e.status===409);assert.equal(await readFile(join(workspace,'records/commitments.json'),'utf8'),before);
 await assert.rejects(service.update({id:task.id,title:'Bad',dueDate:'2026-02-30',expectedRevision:2}),/deadline/);await assert.rejects(service.update({id:task.id,title:'Bad',category:'learn',ownerPath:'research/project/README.md',expectedRevision:2}),/does not match/);
});
test('scheduling resolves local-zone times across DST and rejects gaps, folds, backwards ranges and duplicates',async t=>{
 assert.equal(zonedInstant('2026-11-01T03:30','America/New_York'),'2026-11-01T08:30:00.000Z');assert.throws(()=>zonedInstant('2026-11-01T01:30','America/New_York'),/ambiguous/);assert.throws(()=>zonedInstant('2026-03-08T02:30','America/New_York'),/does not exist/);assert.throws(()=>zonedInstant('2026-02-30T11:30','America/New_York'),/valid/);
 const {service,workspace}=await fixture(t),task=await create(service);await assert.rejects(schedule(service,task.id,{endLocal:'2026-10-21T09:00'}),/later than/);const block=await schedule(service,task.id);await assert.rejects(schedule(service,task.id,{requestId:block.id,expectedCalendarRevision:1}),e=>e.status===409);assert.equal((await readRecords(workspace)).calendar.workBlocks.length,1);
 await service.cancelBlock({id:block.id,expectedCalendarRevision:1});assert.equal((await readRecords(workspace)).calendar.workBlocks[0].status,'cancelled');assert.equal((await readRecords(workspace)).commitments.items[0].status,'open');
});
test('malformed or redirected stores cannot be silently reset by Todo writes',async t=>{
 const {workspace,root,service}=await fixture(t),path=join(workspace,'records/commitments.json');await writeFile(path,'{broken');await assert.rejects(create(service),/invalid JSON/);assert.equal(await readFile(path,'utf8'),'{broken');const protectedFile=join(root,'protected.json');await writeFile(protectedFile,JSON.stringify(emptyCommitments()));await rm(path);await symlink(protectedFile,path);await assert.rejects(create(service),/symbolic/);assert.equal((JSON.parse(await readFile(protectedFile,'utf8'))).revision,0);
});
async function publishFixture(t){const f=await fixture(t);let created,createCalls=0,mode='good',busy=false;
 const google={exclusive:async run=>{if(busy)throw Object.assign(new Error('busy'),{status:409});busy=true;try{return await run();}finally{busy=false;}},discover:async()=>({account:'test@example.invalid',canCreate:true,calendars:[{id:'primary',title:'Personal',writable:true}]}),daily:{createCalendarWorkBlock:async args=>{createCalls++;created={id:'google-event',summary:args.title,start:args.start_time,end:args.end_time,description:args.description,status:'confirmed',url:'https://calendar.google.com/calendar/event?eid=test'};assert.deepEqual(args.attendees,[]);assert.equal(args.self_attendance,'omit');assert.equal(args.add_google_meet,false);if(mode==='timeout')throw new Error('Connection lost');return{structuredContent:created,isError:false};},readCalendarWorkBlock:async()=>({structuredContent:mode==='changed'?{...created,summary:'Changed externally'}:created,isError:false})},call:async()=>({events:[created],next_page_token:null})};
 f.service.google=google;const task=await create(f.service),block=await schedule(f.service,task.id);const input={id:block.id,operationId:randomUUID(),calendarId:'primary',account:'test@example.invalid',expectedCalendarRevision:1,confirmed:true};return{...f,google,input,block,setMode:m=>{mode=m;},calls:()=>createCalls};}
test('Google publishing is a separate reviewed action, verifies its result and cannot double-create',async t=>{
 const f=await publishFixture(t);await assert.rejects(f.service.publish({...f.input,confirmed:false}),/Review/);assert.equal(f.calls(),0);await assert.rejects(f.service.publish({...f.input,account:'other@example.invalid'}),e=>e.status===409);assert.equal(f.calls(),0);
 const result=await f.service.publish(f.input);assert.equal(result.published,true);let records=await readRecords(f.workspace);assert.equal(records.calendar.workBlocks[0].google.state,'published');assert.equal(records.commitments.items[0].status,'open');assert.equal(records.calendar.events[0].id,'keep');
 await assert.rejects(f.service.publish({...f.input,expectedCalendarRevision:records.calendar.revision}),e=>e.status===409);assert.equal(f.calls(),1);await f.service.complete({id:f.block.commitmentId,done:true,expectedRevision:1});records=await readRecords(f.workspace);assert.equal(records.calendar.workBlocks[0].google.eventId,'google-event');
});
test('an uncertain Google response survives restart and reconciles without another create',async t=>{
 const f=await publishFixture(t);f.setMode('timeout');await assert.rejects(f.service.publish(f.input),/not confirmed/);assert.equal(f.calls(),1);let records=await readRecords(f.workspace);assert.equal(records.calendar.workBlocks[0].google.state,'uncertain');assert.equal(records.calendar.workBlocks[0].google.eventId,undefined);
 const restarted=new TodoService({workspace:f.workspace,google:f.google,now:fixed});await assert.rejects(restarted.publish({...f.input,expectedCalendarRevision:records.calendar.revision}),e=>e.status===409);assert.equal(f.calls(),1);f.setMode('good');await restarted.reconcile({id:f.block.id});records=await readRecords(f.workspace);assert.equal(records.calendar.workBlocks[0].google.state,'published');assert.equal(f.calls(),1);
 f.setMode('changed');await assert.rejects(restarted.reconcile({id:f.block.id}),/differs/);assert.equal(f.calls(),1);
});
test('Todo HTTP endpoints require exact origin, CSRF, JSON and bounded input',async t=>{
 const f=await fixture(t);let handler;const server=http.createServer((req,res)=>handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(done=>{server.close(done);server.closeAllConnections();}));const port=server.address().port,origin='http://127.0.0.1:'+port;handler=createRequestHandler({workspace:f.workspace,daily:{csrf:'test-csrf'},port});
 const post=(action,body,headers={})=>fetch(origin+'/api/todos/'+action,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-RUWithMe-CSRF':'test-csrf',...headers},body:JSON.stringify(body)});
 for(const action of ['create','update','today','complete','schedule','publish','check-google','cancel-block']){for(const headers of [{Origin:''},{Origin:'https://attacker.invalid'},{'X-RUWithMe-CSRF':'wrong'}]){const r=await post(action,{},headers);assert.equal(r.status,403);await r.json();}const r=await fetch(origin+'/api/todos/'+action);assert.equal(r.status,405);await r.json();}
 const oversized=await post('create',{text:'a'.repeat(17000)});assert.equal(oversized.status,413);await oversized.json();const type=await post('create',{}, {'Content-Type':'text/plain'});assert.equal(type.status,415);await type.json();
 const r=await post('create',{requestId:randomUUID(),title:'A literal Todo',expectedRevision:0,addToToday:true});assert.equal(r.status,200);const task=await r.json();assert.equal(task.title,'A literal Todo');const indexed=await(await fetch(origin+'/api/workspace')).json();assert.equal(indexed.records.commitments.items[0].id,task.id);assert.equal(indexed.records.calendar.workBlocks.length,0);
});
