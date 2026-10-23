import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import http from 'node:http';
import vm from 'node:vm';
import {TodoService} from '../app/todos.mjs';
import {CommitmentService} from '../app/commitments.mjs';
import {readRecords,readCommitments,emptyCalendar,emptyCommitments,validateCommitments} from '../app/records.mjs';
import {createRequestHandler} from '../app/server.mjs';
import {buildDailyContext} from '../app/daily-context.mjs';
const now=()=>new Date('2026-10-21T15:00:00Z');
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'ru-task-delete-')),workspace=join(root,'workspace');for(const p of ['research/Project','courses','learn','career','admin','personal','inbox','records/days'])await mkdir(join(workspace,p),{recursive:true});
 await writeFile(join(workspace,'research/Project/README.md'),'# Original context\nKeep this file.');for(const [name,data] of [['calendar',emptyCalendar()],['commitments',emptyCommitments()]])await writeFile(join(workspace,'records',name+'.json'),JSON.stringify(data));
 t.after(()=>rm(root,{recursive:true,force:true}));return{root,workspace,todos:new TodoService({workspace,now}),commitments:new CommitmentService({workspace,now})};
}
async function createTodo(f,extra={}){return f.todos.create({requestId:randomUUID(),expectedRevision:(await readCommitments(f.workspace)).revision,title:'Unique task to remove',category:'research',ownerPath:'research/Project/README.md',dueDate:'2026-10-23',addToToday:true,...extra});}
async function createCommitment(f,extra={}){return f.commitments.create({requestId:randomUUID(),expectedRevision:(await readCommitments(f.workspace)).revision,title:'Unique promised deliverable',category:'research',ownerPath:'research/Project/README.md',dueDate:'2026-10-24',person:'Advisor',deliverable:'Original deliverable text',...extra});}
test('delete and restore retain completed status, deadlines, identity, Today choices and original histories across restart',async t=>{
 const f=await fixture(t),todo=await createTodo(f),cm=await createCommitment(f);await f.todos.complete({id:todo.id,done:true,expectedRevision:2});await f.commitments.status({id:cm.id,status:'done',expectedRevision:3});
 const before=await readCommitments(f.workspace),calendar=await readFile(join(f.workspace,'records/calendar.json'),'utf8'),original=await readFile(join(f.workspace,'research/Project/README.md'),'utf8');
 await f.todos.delete({id:todo.id,expectedRevision:4});await f.commitments.delete({id:cm.id,expectedRevision:5});let store=await readCommitments(f.workspace);assert.equal(store.items.length,0);assert.equal(store.trash.length,2);assert.ok(store.trash.every(r=>r.deletedAt&&r.status==='done'));
 await assert.rejects(f.todos.update({id:todo.id,title:'No hidden edit',expectedRevision:6}),e=>e.status===404);await assert.rejects(f.commitments.status({id:cm.id,status:'open',expectedRevision:6}),e=>e.status===404);
 const restartedTodo=new TodoService({workspace:f.workspace,now}),restartedCm=new CommitmentService({workspace:f.workspace,now});await restartedTodo.restore({id:todo.id,expectedRevision:6});await restartedCm.restore({id:cm.id,expectedRevision:7});store=await readCommitments(f.workspace);assert.equal(store.trash.length,0);
 for(const item of store.items){const prior=before.items.find(r=>r.id===item.id);for(const field of ['title','status','dueDate','completedAt','history','todayDates','ownerPath','person','deliverable'])assert.deepEqual(item[field],prior[field]);assert.equal(item.deletedAt,undefined);}
 assert.equal(await readFile(join(f.workspace,'records/calendar.json'),'utf8'),calendar);assert.equal(await readFile(join(f.workspace,'research/Project/README.md'),'utf8'),original);
});
test('deletion removes live records from Daily and deadlines while retaining local blocks and Google receipts byte for byte',async t=>{
 const f=await fixture(t),todo=await createTodo(f),cm=await createCommitment(f);await f.todos.schedule({id:todo.id,requestId:randomUUID(),expectedRevision:2,expectedCalendarRevision:0,startLocal:'2026-10-21T13:00',endLocal:'2026-10-21T14:00'});
 const path=join(f.workspace,'records/calendar.json'),cal=JSON.parse(await readFile(path,'utf8'));cal.workBlocks[0].google={state:'published',operationId:'op',account:'example@invalid.test',calendarId:'primary',marker:'test',startedAt:now().toISOString(),eventId:'google-id',verifiedAt:now().toISOString()};await writeFile(path,JSON.stringify(cal));const bytes=await readFile(path,'utf8');
 await f.todos.delete({id:todo.id,expectedRevision:2});await f.commitments.delete({id:cm.id,expectedRevision:3});const r=await readRecords(f.workspace);assert.equal(r.commitments.items.length,0);assert.equal(r.calendar.workBlocks.length,1);assert.equal(await readFile(path,'utf8'),bytes);
 const context=await buildDailyContext({workspaceRoot:f.workspace,context:{section:'track',view:{trackTab:'todos',todoFilter:'all'}}});const data=JSON.parse(context.slice(context.indexOf('{')));assert.equal(data.records.todos.total,0);assert.equal(data.records.commitments.total,0);assert.ok(!context.includes(cm.title));
});
test('stale, cross-kind and concurrent delete/restore requests cannot resurrect or overwrite another record',async t=>{
 const f=await fixture(t),todo=await createTodo(f),cm=await createCommitment(f);await assert.rejects(f.todos.delete({id:cm.id,expectedRevision:2}),e=>e.status===404);await assert.rejects(f.commitments.delete({id:todo.id,expectedRevision:2}),e=>e.status===404);
 const results=await Promise.allSettled([f.todos.delete({id:todo.id,expectedRevision:2}),f.todos.update({id:todo.id,title:'Concurrent changed title',expectedRevision:2})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
 let s=await readCommitments(f.workspace);if(s.items.some(r=>r.id===todo.id)){await f.todos.delete({id:todo.id,expectedRevision:s.revision});s=await readCommitments(f.workspace);}
 const revision=s.revision;await f.todos.delete({id:todo.id,expectedRevision:revision});assert.equal((await readCommitments(f.workspace)).revision,revision);
 await assert.rejects(f.todos.create({requestId:todo.id,title:'Resurrection attempt',expectedRevision:revision}),e=>e.status===409);await assert.rejects(f.todos.restore({id:todo.id,expectedRevision:revision-1}),e=>e.status===409);
 await f.todos.restore({id:todo.id,expectedRevision:revision});s=await readCommitments(f.workspace);await f.todos.restore({id:todo.id,expectedRevision:s.revision});assert.equal((await readCommitments(f.workspace)).revision,s.revision);assert.equal(s.items.filter(r=>r.id===todo.id).length,1);
 const corrupt=structuredClone(s);corrupt.trash=[{...s.items[0],deletedAt:now().toISOString()}];assert.throws(()=>validateCommitments(corrupt),/duplicate/);
});
test('cancelled Todos leave Today, preserve a cancellation action, and can be restored then reopened',async t=>{
 const f=await fixture(t),todo=await createTodo(f);await f.todos.cancel({id:todo.id,expectedRevision:1});let task=(await readCommitments(f.workspace)).items[0];assert.equal(task.status,'cancelled');assert.equal(task.completedAt,null);assert.equal(task.history[0].action,'cancelled');
 await assert.rejects(f.todos.today({id:todo.id,selected:true,expectedRevision:2}),/Reopen/);await f.todos.delete({id:todo.id,expectedRevision:2});await f.todos.restore({id:todo.id,expectedRevision:3});assert.equal((await readCommitments(f.workspace)).items[0].status,'cancelled');await f.todos.complete({id:todo.id,done:false,expectedRevision:4});task=(await readCommitments(f.workspace)).items[0];assert.equal(task.status,'open');assert.deepEqual(task.history.map(h=>h.action),['cancelled','reopened']);
});
test('legacy commitments retain unknown content through deletion, and Daily labels explicitly selected deleted tasks correctly',async t=>{
 const f=await fixture(t),path=join(f.workspace,'records/commitments.json'),legacy={id:'legacy',title:'Legacy promise',category:'research',status:'waiting',dueDate:'2026-10-24',notes:'Original note',customSource:{keep:true}};
 await writeFile(path,JSON.stringify({...emptyCommitments(),items:[legacy]}));await f.commitments.delete({id:legacy.id,expectedRevision:0});await f.commitments.restore({id:legacy.id,expectedRevision:1});const recovered=(await readCommitments(f.workspace)).items[0];assert.equal(recovered.notes,legacy.notes);assert.deepEqual(recovered.customSource,legacy.customSource);assert.equal(recovered.status,'waiting');
 const todo=await createTodo(f);await f.todos.delete({id:todo.id,expectedRevision:3});const raw=await buildDailyContext({workspaceRoot:f.workspace,context:{section:'track',view:{trackTab:'todos',todoFilter:'deleted',selectedTodoId:todo.id}}}),context=JSON.parse(raw.slice(raw.indexOf('{')));
 assert.equal(context.page.view.todoFilter,'deleted');assert.equal(context.records.todos.total,0);assert.equal(context.records.deletedTodos.total,1);assert.equal(context.selection.todo.matchesVisibleTodoFilter,true);assert.match(context.selection.todo.savedRecord.recordState,/deleted locally/);
});
test('delete and restore APIs require exact Origin, CSRF, bounded JSON and latest shared revision',async t=>{
 const f=await fixture(t),todo=await createTodo(f),cm=await createCommitment(f);let handler;const server=http.createServer((req,res)=>handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port,origin='http://127.0.0.1:'+port;handler=createRequestHandler({workspace:f.workspace,daily:{csrf:'test'},port});t.after(()=>new Promise(done=>{server.closeAllConnections();server.close(done);}));
 const post=(path,body,headers={})=>fetch(origin+path,{method:'POST',headers:{Origin:origin,'X-RUWithMe-CSRF':'test','Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 for(const group of ['todos','commitments'])for(const action of ['delete','restore']){const path='/api/'+group+'/'+action;for(const headers of [{Origin:''},{Origin:'https://other.invalid'},{'X-RUWithMe-CSRF':'wrong'}]){const r=await post(path,{},headers);assert.equal(r.status,403);await r.text();}let r=await fetch(origin+path);assert.equal(r.status,405);await r.text();r=await post(path,{x:'x'.repeat(17000)});assert.equal(r.status,413);await r.text();}
 let r=await post('/api/todos/delete',{id:todo.id,expectedRevision:2});assert.equal(r.status,200);await r.json();r=await post('/api/commitments/delete',{id:cm.id,expectedRevision:2});assert.equal(r.status,409);await r.json();r=await post('/api/todos/restore',{id:todo.id,expectedRevision:3});assert.equal(r.status,200);await r.json();assert.equal((await readCommitments(f.workspace)).items.length,2);
});
test('active lists render cards; large archives render one-line items without expanded details or active actions',async()=>{
 const listeners=[],document={addEventListener:(name,fn)=>listeners.push(fn)},context={window:{},document,Intl,Date};
 const cm={id:'cm',kind:'commitment',title:'<unsafe title>',category:'research',status:'open',dueDate:'2026-10-23',person:'Advisor',deliverable:'PRIVATE_LONG_DETAIL',history:[]},todo={id:'todo',kind:'todo',title:'Read a paper',category:'research',status:'open',todayDates:['2026-10-21'],history:[]};
 const snapshot={items:{},records:{commitments:{revision:0,items:[cm,todo],trash:[]},calendar:emptyCalendar()}},api={snapshot:()=>snapshot,render(){},section:()=> 'track'};
 vm.runInNewContext(await readFile(new URL('../app/commitment-ui.js',import.meta.url),'utf8'),context);context.window.RUCommitments.init(api);let html=context.window.RUCommitments.dashboard();assert.match(html,/task-card-grid/);assert.ok(html.includes('&lt;unsafe title&gt;'));assert.ok(!html.includes('<unsafe title>'));
 snapshot.records.commitments.items=Array.from({length:80},(_,i)=>({...cm,id:'cm-'+i,status:i%2?'done':'cancelled',updatedAt:now().toISOString()}));await listeners[0]({target:{closest:()=>({disabled:false,dataset:{cmFilter:'archived'},hasAttribute:()=>false})}});html=context.window.RUCommitments.dashboard();assert.equal((html.match(/class="task-compact-row"/g)||[]).length,80);assert.match(html,/task-compact-list/);assert.ok(!html.includes('PRIVATE_LONG_DETAIL'));assert.ok(!html.includes('data-cm-edit='));
 snapshot.records.commitments.items=[{...todo,status:'cancelled'}];vm.runInNewContext(await readFile(new URL('../app/todo-ui.js',import.meta.url),'utf8'),context);context.window.RUTodos.init(api);assert.ok(!context.window.RUTodos.todayCard().includes('data-todo-complete="todo"'));
 await listeners.at(-1)({target:{closest:()=>({disabled:false,dataset:{todoFilter:'done'},hasAttribute:()=>false})}});html=context.window.RUTodos.render(false,true);assert.match(html,/task-compact-row/);assert.match(html,/Cancelled/);assert.ok(!html.includes('data-todo-schedule='));
});
