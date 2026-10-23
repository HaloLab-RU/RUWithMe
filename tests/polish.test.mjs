import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {once} from 'node:events';
import {buildDemo} from '../scripts/seed-demo.mjs';
import {indexWorkspace} from '../app/workspace.mjs';
import {readCalendar,readCommitments,readTrack} from '../app/records.mjs';
import {TodoService} from '../app/todos.mjs';
import {TrackService} from '../app/track.mjs';
import {SessionService} from '../app/sessions.mjs';
import {saveLocalEvent} from '../app/local-events.mjs';
import {uploadMaterial,fileInboxCopy} from '../app/materials.mjs';
import {createRequestHandler} from '../app/server.mjs';
import {buildDailyContext} from '../app/daily-context.mjs';
import vm from 'node:vm';

async function fixture(t){const root=await mkdtemp(join(tmpdir(),'ruwithme-polish-'));t.after(()=>rm(root,{recursive:true,force:true}));const data=await buildDemo(root);return{root,data};}
test('sample workspace is coherent, synthetic, manually maintained and valid across all record stores',async t=>{
 const {root,data}=await fixture(t);assert.equal(data.demo.scenarioDate,'2026-10-21');assert.equal(data.counts.research,3);assert.equal(data.counts.courses,2);assert.equal(data.counts.learn,2);assert.ok(data.items.courses.every(course=>!course.canvas));
 for(const item of [...data.items.research,...data.items.courses,...data.items.learn]){assert.ok(item.summary&&item.next&&item.notes);assert.match(await readFile(join(root,item.path),'utf8'),/Synthetic example/);}
 for(const row of [...data.records.commitments.items,...data.records.sessions.items,...data.records.track.entries])assert.equal(row.synthetic,true);
 for(const task of data.records.commitments.items.filter(row=>row.parentCommitmentId))assert.ok(data.records.commitments.items.some(row=>row.id===task.parentCommitmentId&&row.kind==='commitment'));
 assert.equal(data.records.calendar.sources.length,0);assert.ok(data.items.research[0].files.some(file=>file.name.endsWith('.pdf')));
 const before=await readFile(join(root,'records/commitments.json'));await indexWorkspace(root);assert.deepEqual(await readFile(join(root,'records/commitments.json')),before);
});
test('sample date is consistent across Today selection, Track and actual-work validation without a model write',async t=>{
 const {root}=await fixture(t),now=()=>new Date('2026-10-28T14:00:00Z'),store=await readCommitments(root),todos=new TodoService({workspace:root,now});
 const task=await todos.create({requestId:randomUUID(),expectedRevision:store.revision,title:'A manually chosen action',category:'learn',addToToday:true});assert.deepEqual(task.todayDates,['2026-10-21']);
 let start;const track=new TrackService({workspace:root,projectRoot:join(root,'..'),now,daily:{startTurn:async input=>{start=input;return{active:true};}}});await track.start({type:'plan',date:'2026-10-21',requestId:randomUUID()},'http://127.0.0.1:4191');assert.match(start.text,/Today is 2026-10-21/);
 const sessions=new SessionService({workspace:root,now});await assert.rejects(sessions.save({id:randomUUID(),expectedRevision:1,date:'2026-10-22',workedOn:'Future activity',files:[]}),{status:400});
 await assert.rejects(todos.publish({}),/Sample work blocks stay local/);
 const output=await buildDailyContext({workspaceRoot:root,context:JSON.stringify({section:'today'})}),context=JSON.parse(output.slice(output.indexOf('\n')+1));assert.equal(context.demo.synthetic,true);assert.equal(context.demo.scenarioDate,'2026-10-21');assert.match(context.demo.note,/not present.*actual work/);
});
test('linked actions keep their own deadline and completion; effort and parent identities are validated',async t=>{
 const {root,data}=await fixture(t),parent=data.records.commitments.items.find(row=>row.kind==='commitment'),service=new TodoService({workspace:root});let revision=data.records.commitments.revision;
 const action=await service.create({requestId:randomUUID(),expectedRevision:revision,title:'Manually create a linked action',category:'research',ownerPath:parent.ownerPath,parentCommitmentId:parent.id,estimateMinutes:25});revision++;
 assert.equal(action.dueDate,null);assert.equal(action.estimateMinutes,25);await service.complete({id:action.id,expectedRevision:revision,done:true});revision++;
 const saved=await readCommitments(root);assert.deepEqual(saved.items.find(row=>row.id===parent.id),parent);assert.equal(saved.items.find(row=>row.id===action.id).status,'done');
 for(const extra of [{parentCommitmentId:action.id},{estimateMinutes:0},{estimateMinutes:5.5},{estimateMinutes:1441}])await assert.rejects(service.create({requestId:randomUUID(),expectedRevision:revision,title:'Invalid action',category:'research',...extra}));
 assert.equal((await readCommitments(root)).revision,revision);
});
test('filing and uploads preserve bytes, original links and collision boundaries',async t=>{
 const {root,data}=await fixture(t),ownerPath=data.items.research[0].path,body=Buffer.from([37,80,68,70,0,255,10]);
 const upload=await uploadMaterial(root,{ownerPath,name:'original.pdf',body});assert.deepEqual(await readFile(join(root,upload.path)),body);
 await assert.rejects(uploadMaterial(root,{ownerPath,name:'original.pdf',body:Buffer.from('replace')}),{status:409});assert.deepEqual(await readFile(join(root,upload.path)),body);
 const source=data.inbox.find(row=>row.name==='reading-questions.md'),before=await readFile(join(root,source.path));
 await assert.rejects(fileInboxCopy(root,{path:source.path,ownerPath,expectedSize:0,expectedModified:source.modified}),{status:409});
 const receipt=await fileInboxCopy(root,{path:source.path,ownerPath,folder:'notes',expectedSize:source.size,expectedModified:source.modified});assert.deepEqual(await readFile(join(root,receipt.path)),before);assert.deepEqual(await readFile(join(root,source.path)),before);
 const updated=await indexWorkspace(root);assert.equal(updated.inbox.find(row=>row.path===source.path).filedTo[0].path,receipt.path);
 await assert.rejects(fileInboxCopy(root,{path:source.path,ownerPath,folder:'notes',expectedSize:source.size,expectedModified:source.modified}),{status:409});
});
test('material operations reject escaping paths and symbolic-link folders without overwriting outside files',async t=>{
 const {root,data}=await fixture(t),ownerPath=data.items.research[0].path;
 for(const name of ['../outside.pdf','.hidden.md','bad.exe'])await assert.rejects(uploadMaterial(root,{ownerPath,name,body:Buffer.from('x')}));
 await assert.rejects(uploadMaterial(root,{ownerPath:'research/../README.md',name:'note.md',body:Buffer.from('x')}),{status:403});
 const outside=await mkdtemp(join(tmpdir(),'ruwithme-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));await mkdir(join(root,'learn/Linked'));await writeFile(join(root,'learn/Linked/README.md'),'# Linked');await symlink(outside,join(root,'learn/Linked/files'));await assert.rejects(uploadMaterial(root,{ownerPath:'learn/Linked/README.md',name:'note.md',body:Buffer.from('x')}),{status:403});
});
test('local event editing and cancellation preserve imported-event ownership and planned work',async t=>{
 const {root,data}=await fixture(t),original=await readCalendar(root),ownerPath=data.items.courses[0].path;
 await saveLocalEvent(root,{expectedRevision:original.revision,title:'Local study group',location:'Library',ownerPath,allDay:false,startLocal:'2026-10-22T13:00',endLocal:'2026-10-22T14:00'});
 let calendar=await readCalendar(root),row=calendar.events.find(row=>row.title==='Local study group');assert.equal(row.ownerPath,ownerPath);assert.equal(row.startAt,'2026-10-22T17:00:00.000Z');assert.deepEqual(calendar.workBlocks,original.workBlocks);
 await assert.rejects(saveLocalEvent(root,{expectedRevision:calendar.revision,title:'Invalid DST',location:'',allDay:false,startLocal:'2026-03-08T02:30',endLocal:'2026-03-08T04:00'}),/does not exist/);
 await saveLocalEvent(root,{id:row.id,expectedRevision:calendar.revision,cancel:true});calendar=await readCalendar(root);assert.equal(calendar.events.find(event=>event.id===row.id).status,'cancelled');
 await saveLocalEvent(root,{expectedRevision:calendar.revision,title:'All-day deadline review',location:'',allDay:true,startDate:'2026-10-23',endDate:'2026-10-24'});calendar=await readCalendar(root);assert.equal(calendar.events.at(-1).endDate,'2026-10-24');
 const imported={...original.events[0],sourceId:'external-source',sourceEventId:'external-event'};calendar.sources=[{id:'external-source',provider:'outlook'}];calendar.events.push({...imported,id:randomUUID()});await writeFile(join(root,'records/calendar.json'),JSON.stringify(calendar));
 await assert.rejects(saveLocalEvent(root,{id:calendar.events.at(-1).id,expectedRevision:calendar.revision,cancel:true}),{status:409});
});
test('new material/local-calendar routes enforce CSRF and serve the PDF worker locally',async t=>{
 const {root,data}=await fixture(t);let handler;const server=http.createServer((req,res)=>handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port,origin='http://127.0.0.1:'+port;handler=createRequestHandler({workspace:root,port,daily:{csrf:'test-only'}});t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 for(const path of ['/api/materials/upload','/api/materials/file-inbox','/api/calendar/local/save'])assert.equal((await fetch(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'})).status,403);
 const ownerPath=data.items.learn[0].path,response=await fetch(origin+'/api/materials/upload?'+new URLSearchParams({ownerPath,name:'ui-note.md'}),{method:'POST',headers:{Origin:origin,'X-RUWithMe-CSRF':'test-only','Content-Type':'application/octet-stream'},body:'# A local note'});assert.equal(response.status,201);assert.equal(await readFile(join(root,(await response.json()).path),'utf8'),'# A local note');
 for(const path of ['/vendor/pdf.mjs','/vendor/pdf.worker.mjs','/today-ui.js']){const asset=await fetch(origin+path);assert.equal(asset.status,200);assert.match(asset.headers.get('content-type'),/javascript/);await asset.arrayBuffer();}
});
test('commitment details expose linked actions and require a manual Add Todo form',async t=>{
 const {data}=await fixture(t),handlers={},context={window:{},document:{addEventListener:(type,callback)=>{handlers[type]=callback;}},Intl,Date};
 vm.runInNewContext(await readFile(new URL('../app/commitment-ui.js',import.meta.url),'utf8'),context);let html='';context.window.RUCommitments.init({snapshot:()=>data,dialog:(title,value)=>{html=value;}});
 const parent=data.records.commitments.items.find(row=>row.kind==='commitment');await handlers.click({target:{closest:()=>({dataset:{cmView:parent.id},hasAttribute:()=>false})}});
 assert.match(html,/Linked actions/);assert.ok(html.includes('Check the weight-bound assumption'));assert.ok(html.includes('data-todo-parent="'+parent.id+'"'));assert.match(html,/Action completion and final delivery are recorded separately/);
});
