import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {once} from 'node:events';
import {CommitmentService} from '../app/commitments.mjs';
import {TodoService} from '../app/todos.mjs';
import {emptyCalendar,emptyCommitments,readRecords} from '../app/records.mjs';
import {createRequestHandler} from '../app/server.mjs';
const now=()=>new Date('2026-10-20T18:00:00Z');
async function fixture(t){const root=await realpath(await mkdtemp(join(tmpdir(),'ru-commitments-'))),workspace=join(root,'workspace');for(const d of ['research/project','courses','learn','career','admin','personal','inbox','records/days'])await mkdir(join(workspace,d),{recursive:true});await writeFile(join(workspace,'research/project/README.md'),'# Project');await writeFile(join(workspace,'records/commitments.json'),JSON.stringify(emptyCommitments()));await writeFile(join(workspace,'records/calendar.json'),JSON.stringify(emptyCalendar()));t.after(()=>rm(root,{force:true,recursive:true}));return{root,workspace,service:new CommitmentService({workspace,now}),todos:new TodoService({workspace,now})};}
const input=(extra={})=>({requestId:randomUUID(),expectedRevision:0,title:'Send simulation results',category:'research',ownerPath:'research/project/README.md',dueDate:'2026-10-23',person:'Advisor',deliverable:'Plots and summary',...extra});
test('commitment creation, editing, waiting, completion and reopen persist while preserving Todo and Calendar',async t=>{
 const f=await fixture(t),todo=await f.todos.create({requestId:randomUUID(),expectedRevision:0,title:'Existing Todo'}),calendar=await readFile(join(f.workspace,'records/calendar.json'),'utf8');
 const item=await f.service.create(input({expectedRevision:1}));assert.equal(item.kind,'commitment');assert.equal(item.dueDate,'2026-10-23');assert.equal(item.person,'Advisor');
 await f.service.update({...input(),id:item.id,expectedRevision:2,status:'waiting',waitingOn:'Confirm dataset',dueTime:'17:00'});
 let saved=(await readRecords(f.workspace)).commitments.items.find(r=>r.id===item.id);assert.equal(saved.status,'waiting');assert.equal(saved.dueAt,'2026-10-23T21:00:00.000Z');assert.equal(saved.dueDate,null);assert.equal(saved.waitingOn,'Confirm dataset');
 await f.service.status({id:item.id,status:'done',expectedRevision:3});saved=(await readRecords(f.workspace)).commitments.items.find(r=>r.id===item.id);assert.equal(saved.completedAt,now().toISOString());
 const restarted=new CommitmentService({workspace:f.workspace,now});await restarted.status({id:item.id,status:'open',expectedRevision:4});const records=await readRecords(f.workspace);saved=records.commitments.items.find(r=>r.id===item.id);assert.equal(saved.completedAt,null);assert.equal(saved.dueAt,'2026-10-23T21:00:00.000Z');assert.deepEqual(saved.history.map(h=>h.to),['waiting','done','open']);assert.deepEqual(records.commitments.items.find(r=>r.id===todo.id),todo);assert.equal(await readFile(join(f.workspace,'records/calendar.json'),'utf8'),calendar);assert.deepEqual(records.days,[]);
 await assert.rejects(restarted.status({id:todo.id,status:'done',expectedRevision:5}),e=>e.status===404);
});
test('deadlines, exact DST times and owner/category mismatch are validated before writes',async t=>{
 const f=await fixture(t),path=join(f.workspace,'records/commitments.json'),before=await readFile(path,'utf8');
 for(const extra of [{dueDate:null},{dueDate:'2026-02-30'},{dueTime:'25:00'},{dueDate:'2026-11-01',dueTime:'01:30'},{dueDate:'2026-03-08',dueTime:'02:30'},{person:{}},{status:'nonsense'},{category:'personal'},{ownerPath:'research/../project/README.md'}])await assert.rejects(f.service.create(input(extra)));
 assert.equal(await readFile(path,'utf8'),before);
});
test('Commitments and Todos share a lock/revision; stale writes and duplicate creation preserve records',async t=>{
 const f=await fixture(t),a=input();await f.service.create(a);await f.service.create({...a,expectedRevision:1});assert.equal((await readRecords(f.workspace)).commitments.revision,1);
 const results=await Promise.allSettled([f.service.create(input({expectedRevision:1})),f.todos.create({requestId:randomUUID(),expectedRevision:1,title:'Concurrent Todo'})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
 const path=join(f.workspace,'records/commitments.json'),before=await readFile(path,'utf8');await assert.rejects(f.service.status({id:a.requestId,status:'done',expectedRevision:1}),e=>e.status===409);assert.equal(await readFile(path,'utf8'),before);
});
test('legacy non-Todo commitments retain unknown fields on explicit edit; invalid stores stay intact',async t=>{
 const f=await fixture(t),path=join(f.workspace,'records/commitments.json'),legacy={id:'old',title:'Legacy',category:'research',status:'open',dueDate:'2026-10-23',notes:'Keep notes',followUpDate:'2026-10-22'};
 await writeFile(path,JSON.stringify({...emptyCommitments(),items:[legacy]}));await f.service.update({...input(),id:'old'});const saved=(await readRecords(f.workspace)).commitments.items[0];assert.equal(saved.notes,'Keep notes');assert.equal(saved.followUpDate,'2026-10-22');
 await writeFile(path,'{bad');await assert.rejects(f.service.create(input()),/invalid JSON/);assert.equal(await readFile(path,'utf8'),'{bad');await rm(path);const target=join(f.root,'protected.json');await writeFile(target,JSON.stringify(emptyCommitments()));await symlink(target,path);await assert.rejects(f.service.create(input()),/symbolic/);assert.equal(JSON.parse(await readFile(target,'utf8')).revision,0);
});
test('Commitment HTTP mutations enforce Origin, CSRF, bounded JSON and persist into workspace reads',async t=>{
 const f=await fixture(t);let handler;const server=http.createServer((req,res)=>handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(done=>{server.close(done);server.closeAllConnections();}));const port=server.address().port,origin='http://127.0.0.1:'+port;handler=createRequestHandler({workspace:f.workspace,daily:{csrf:'test'},port});
 const post=(action,data,headers={})=>fetch(origin+'/api/commitments/'+action,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-RUWithMe-CSRF':'test',...headers},body:JSON.stringify(data)});
 for(const action of ['create','update','status']){for(const headers of [{Origin:''},{Origin:'https://other.invalid'},{'X-RUWithMe-CSRF':'bad'}]){const r=await post(action,{},headers);assert.equal(r.status,403);await r.json();}const get=await fetch(origin+'/api/commitments/'+action);assert.equal(get.status,405);await get.json();}
 for(const [data,headers,status] of [[{}, {'Content-Type':'text/plain'},415],[{text:'x'.repeat(17000)},{},413],[[],{},400]]){const r=await post('create',data,headers);assert.equal(r.status,status);await r.json();}
 const r=await post('create',input());assert.equal(r.status,200);const item=await r.json(),snapshot=await(await fetch(origin+'/api/workspace')).json();assert.equal(snapshot.records.commitments.items[0].id,item.id);assert.equal(snapshot.records.calendar.events.length,0);
});
