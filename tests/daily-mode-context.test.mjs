import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile,symlink,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildDemo} from '../scripts/seed-demo.mjs';
import {indexWorkspace} from '../app/workspace.mjs';
import {readRecords,readSessions} from '../app/records.mjs';
import {readContent,saveContent} from '../app/content.mjs';
import {workspaceDay,readDemo} from '../app/demo.mjs';
import {modePreview,startDailyMode} from '../app/daily-mode.mjs';
import {contextProposal,applySessionContext} from '../app/session-context.mjs';
import {SessionService} from '../app/sessions.mjs';
import {TodoService} from '../app/todos.mjs';
import {TrackService} from '../app/track.mjs';
import {saveLocalEvent} from '../app/local-events.mjs';
import {createRequestHandler} from '../app/server.mjs';
import http from 'node:http';
import {once} from 'node:events';
import vm from 'node:vm';
const archive={tasks:true,calendar:true,sessions:true,track:true};
test('Today can resume an empty real workspace and respects a reviewed next step without changing the session',async()=>{
 const context={window:{},Intl,Date};vm.runInNewContext(await readFile(new URL('../app/today-ui.js',import.meta.url),'utf8'),context);
 const data={records:{calendar:{timeZone:'America/New_York'},sessions:{items:[]}}};context.window.RUToday.init({snapshot:()=>data,escape:value=>String(value)});
 const project={id:'project',path:'research/Test/README.md',title:'Research',files:[],next:'Project starting point',contextSession:null};assert.match(context.window.RUToday.resume(project),/No session yet/);
 const session={id:'session',revision:1,date:'2026-10-20',createdAt:'2026-10-20T12:00:00Z',ownerPath:project.path,nextStep:'Original logged next step',files:[]};data.records.sessions.items.push(session);project.next='Reviewed replacement next step';project.contextSession={id:session.id,revision:1,fields:['next']};const html=context.window.RUToday.resume(project);assert.match(html,/Reviewed replacement next step/);assert.equal(session.nextStep,'Original logged next step');
});
async function fixture(t){const folder=await mkdtemp(join(tmpdir(),'ruwithme-daily-')),root=join(folder,'workspace');await mkdir(root);t.after(()=>rm(folder,{recursive:true,force:true}));const data=await buildDemo(root);return{folder,root,data};}
async function start(root,options={}){return startDailyMode(root,{expectedRevision:(await modePreview(root)).revision,archive,confirmed:true,operationId:randomUUID(),...options},()=>new Date('2026-10-22T12:00:00Z'));}
test('daily mode uses real local dates and reversibly archives only views; files and raw records stay byte-identical',async t=>{
 const {folder,root,data}=await fixture(t),paths=['records/commitments.json','records/calendar.json','records/sessions.json','records/track.json',data.items.research[0].path,data.items.research[0].files[0].path],before=await Promise.all(paths.map(path=>readFile(join(root,path)))),manifest=await readFile(join(root,'.demo.json'),'utf8');
 const preview=await modePreview(root);assert.equal(preview.daily,false);assert.equal(preview.groups.tasks.length,11);
 await assert.rejects(start(root,{confirmed:false}),{status:400});assert.equal(await readFile(join(root,'.demo.json'),'utf8'),manifest);
 const mode=await start(root);assert.equal(await readDemo(root),null);assert.equal(await workspaceDay(root,new Date('2026-10-23T03:59:00Z'),'America/New_York'),'2026-10-22');assert.equal(await workspaceDay(root,new Date('2026-10-23T04:01:00Z'),'America/New_York'),'2026-10-23');
 const index=await indexWorkspace(root);assert.equal(index.records.commitments.items.length,0);assert.equal(index.records.sessions.items.length,0);assert.equal(index.records.track.entries.length,0);assert.equal(index.records.calendar.events.length,0);assert.equal(index.items.research.length,3);
 for(const [i,path] of paths.entries())assert.deepEqual(await readFile(join(root,path)),before[i]);
 const backup=JSON.parse(await readFile(join(folder,'.ruwithme/backups/daily-mode',mode.backupId,'previous-mode.json'),'utf8'));assert.deepEqual(backup.value,JSON.parse(manifest));
 const track=new TrackService({workspace:root,daily:{},now:()=>new Date('2026-10-22T12:00:00Z')});assert.equal((await track.view()).entries.length,0);
 await start(root,{archive:{tasks:false,calendar:false,sessions:false,track:false}});assert.equal((await indexWorkspace(root)).records.commitments.items.length,11);assert.equal(await readDemo(root),null);
});
test('daily mode retains personal records, edited examples and example parents referenced by real actions',async t=>{
 const {root,data}=await fixture(t),parent=data.records.commitments.items.find(row=>row.kind==='commitment');
 const todo=await new TodoService({workspace:root}).create({requestId:randomUUID(),expectedRevision:1,title:'My own research action',category:'research',ownerPath:parent.ownerPath,parentCommitmentId:parent.id});
 const row=data.records.sessions.items[0];await new SessionService({workspace:root}).save({...row,expectedRevision:1,expectedItemRevision:1,outcome:'My corrected observation'});
 const event=data.records.calendar.events[0];await saveLocalEvent(root,{id:event.id,expectedRevision:1,title:'My edited meeting',ownerPath:event.ownerPath,location:'Local room',allDay:false,startLocal:'2026-10-21T11:00',endLocal:'2026-10-21T12:00'});
 await start(root);const index=await indexWorkspace(root);assert.ok(index.records.commitments.items.some(row=>row.id===todo.id));assert.ok(index.records.commitments.items.some(row=>row.id===parent.id));assert.equal(index.records.sessions.items[0].outcome,'My corrected observation');assert.equal(index.records.calendar.events[0].title,'My edited meeting');
});
test('stale mode previews, failed backups and retries do not lose content or silently apply different choices',async t=>{
 const {root,folder}=await fixture(t),preview=await modePreview(root),original=await readFile(join(root,'.demo.json'));
 await writeFile(join(root,'inbox/new-note.md'),'My new note');await assert.rejects(startDailyMode(root,{expectedRevision:preview.revision,archive,confirmed:true,operationId:randomUUID()}),{status:409});assert.deepEqual(await readFile(join(root,'.demo.json')),original);
 const outside=await mkdtemp(join(tmpdir(),'ruwithme-mode-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));await symlink(outside,join(folder,'.ruwithme'));await assert.rejects(start(root),{status:403});assert.deepEqual(await readFile(join(root,'.demo.json')),original);await rm(join(folder,'.ruwithme'));
 const operationId=randomUUID(),request={expectedRevision:(await modePreview(root)).revision,archive,confirmed:true,operationId},one=await startDailyMode(root,request),two=await startDailyMode(root,request);assert.deepEqual(two,one);await assert.rejects(startDailyMode(root,{...request,archive:{...archive,tasks:false}}),{status:409});assert.equal(await readFile(join(root,'inbox/new-note.md'),'utf8'),'My new note');
});
test('retained synthetic work blocks cannot publish to Google after switching to daily mode',async t=>{
 const {root,data}=await fixture(t);await start(root,{archive:{tasks:false,calendar:false,sessions:false,track:false}});
 const google={exclusive:async action=>action(),discover:async()=>{throw new Error('External access must not occur');}},service=new TodoService({workspace:root,google});
 await assert.rejects(service.publish({id:data.records.calendar.workBlocks[0].id,expectedCalendarRevision:1,confirmed:true,operationId:randomUUID(),calendarId:'test',account:'test@example.com'}),/Sample work blocks stay local/);
});
test('session promotion changes only reviewed fields, preserves the session and unknown metadata, and records source/history',async t=>{
 const {root,data}=await fixture(t),row=data.records.sessions.items[0],path=join(root,row.ownerPath);await writeFile(path,(await readFile(path,'utf8')).replace('---\n','---\ncustom_tag: "keep me"\n'));
 const before=await readContent(root,row.ownerPath),sessions=await readFile(join(root,'records/sessions.json')),proposal=await contextProposal(root,row.id);assert.equal(proposal.suggested.next,row.nextStep);assert.equal(proposal.current.currentUnderstanding,'');
 const request={id:row.id,expectedSessionRevision:row.revision,expectedRevision:proposal.expectedRevision,changes:{currentUnderstanding:'Reviewed understanding',next:'My edited next step'},confirmed:true};
 await assert.rejects(applySessionContext(root,{...request,confirmed:false}),{status:400});assert.equal((await readContent(root,row.ownerPath)).revision,before.revision);
 const saved=await applySessionContext(root,request);assert.equal(saved.fields.next,'My edited next step');assert.equal(saved.fields.currentUnderstanding,'Reviewed understanding');assert.equal(saved.fields.openQuestions,'');assert.equal(saved.fields.summary,before.fields.summary);assert.equal(saved.fields.status,before.fields.status);assert.equal(saved.fields.notes,before.fields.notes);assert.match(saved.content,/custom_tag: "keep me"/);assert.equal(saved.contextSource.id,row.id);assert.deepEqual(saved.contextSource.fields,['currentUnderstanding','next']);assert.deepEqual(await readFile(join(root,'records/sessions.json')),sessions);
 assert.ok((await readdir(join(root,row.ownerPath.slice(0,-10),'.edit-history'))).length);const item=(await indexWorkspace(root)).items.research.find(item=>item.path===row.ownerPath);assert.equal(item.currentUnderstanding,'Reviewed understanding');assert.deepEqual((await contextProposal(root,row.id)).appliedFields,['currentUnderstanding','next']);
});
test('stale project and session revisions preserve both independently edited sources',async t=>{
 const {root,data}=await fixture(t),row=data.records.sessions.items[0],proposal=await contextProposal(root,row.id),request={id:row.id,expectedSessionRevision:1,expectedRevision:proposal.expectedRevision,changes:{next:'Draft next step'},confirmed:true};
 const content=await readContent(root,row.ownerPath);await saveContent(root,{path:row.ownerPath,expectedRevision:content.revision,fields:{...content.fields,next:'Another editor saved this'}});await assert.rejects(applySessionContext(root,request),{status:409});assert.equal((await readContent(root,row.ownerPath)).fields.next,'Another editor saved this');
 const fresh=await contextProposal(root,row.id);await new SessionService({workspace:root}).save({...row,expectedRevision:1,expectedItemRevision:1,outcome:'A revised observation'});await assert.rejects(applySessionContext(root,{...request,expectedRevision:fresh.expectedRevision}),{status:409});assert.equal((await readSessions(root)).items.find(item=>item.id===row.id).outcome,'A revised observation');
});
test('real daily mode accepts a personal session update but rejects using sample outcomes as real context',async t=>{
 const {root,data}=await fixture(t);await start(root);const sample=data.records.sessions.items[0],p=await contextProposal(root,sample.id);assert.equal(p.sampleBlocked,true);await assert.rejects(applySessionContext(root,{id:sample.id,expectedSessionRevision:1,expectedRevision:p.expectedRevision,changes:{next:'Example'},confirmed:true}),{status:409});
 const store=await readSessions(root),row=await new SessionService({workspace:root,now:()=>new Date('2026-10-22T12:00:00Z')}).save({id:randomUUID(),expectedRevision:store.revision,date:'2026-10-22',ownerPath:sample.ownerPath,workedOn:'Checked my actual proof',outcome:'A new assumption is needed.',blockers:'',nextStep:'State the assumption.',files:[]});const proposed=await contextProposal(root,row.id);await applySessionContext(root,{id:row.id,expectedSessionRevision:1,expectedRevision:proposed.expectedRevision,changes:{currentUnderstanding:row.outcome},confirmed:true});assert.equal((await readContent(root,row.ownerPath)).fields.currentUnderstanding,row.outcome);
});
test('mode and promotion HTTP routes require explicit confirmation, JSON, matching Origin and CSRF',async t=>{
 const {root,data}=await fixture(t);let handler;const server=http.createServer((req,res)=>handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port,origin='http://127.0.0.1:'+port;handler=createRequestHandler({workspace:root,port,daily:{csrf:'test-only'}});t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 for(const path of ['/api/workspace/mode/start','/api/sessions/project-context/save'])assert.equal((await fetch(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'})).status,403);
 const row=data.records.sessions.items[0],response=await fetch(origin+'/api/sessions/project-context?'+new URLSearchParams({id:row.id}));assert.equal(response.status,200);const p=await response.json();
 const saved=await fetch(origin+'/api/sessions/project-context/save',{method:'POST',headers:{Origin:origin,'X-RUWithMe-CSRF':'test-only','Content-Type':'application/json'},body:JSON.stringify({id:row.id,expectedSessionRevision:1,expectedRevision:p.expectedRevision,changes:{next:'Reviewed through the API'},confirmed:true})});assert.equal(saved.status,200);assert.equal((await saved.json()).fields.next,'Reviewed through the API');
});

test('sample projects can be reversibly archived with original materials and identities preserved',async t=>{
 const {root,data}=await fixture(t),before=await readFile(join(root,data.items.research[0].path)),paths=Object.values(data.items).flat().map(row=>row.path).sort();
 assert.equal((await modePreview(root)).groups.workspaces.length,7);
 await assert.rejects(start(root,{archive:{...archive,workspaces:'true'}}),{status:400});
 await start(root,{archive:{...archive,workspaces:true}});
 const hidden=await indexWorkspace(root);assert.deepEqual([hidden.counts.research,hidden.counts.courses,hidden.counts.learn],[0,0,0]);assert.deepEqual(await readFile(join(root,data.items.research[0].path)),before);
 assert.equal((await modePreview(root)).groups.workspaces.filter(row=>row.archived).length,7);
 await start(root,{archive:{...archive,workspaces:false}});assert.deepEqual(Object.values((await indexWorkspace(root)).items).flat().map(row=>row.path).sort(),paths);
});
test('changed source bytes, additional material, properties and personal record references protect sample projects',async t=>{
 const {root,data}=await fixture(t),[a,b,c]=data.items.research,[d,e]=data.items.courses,[f,g]=data.items.learn;
 await writeFile(join(root,a.path),(await readFile(join(root,a.path),'utf8'))+'\nMy own note.\n');
 await writeFile(join(root,b.folder,'files/my-notes.txt'),'Personal notes');
 await mkdir(join(root,c.folder,'.edit-history'));await writeFile(join(root,c.folder,'.edit-history/prior.txt'),'A previous version');
 await writeFile(join(root,d.folder,'notes/recitation-outline.md'),'A changed original note.');
 await new TodoService({workspace:root}).create({requestId:randomUUID(),expectedRevision:1,title:'My own action',category:'courses',ownerPath:e.path});
 const {saveMaterialProperties}=await import('../app/material-properties.mjs');await saveMaterialProperties(root,{path:f.files[0].path,expectedRevision:0,summary:'My own summary',priority:'high',properties:[]});
 const preview=await modePreview(root);assert.equal(preview.protectedWorkspaces.length,6);assert.deepEqual(preview.groups.workspaces.map(row=>row.id),[g.id]);
 await start(root,{archive:{...archive,workspaces:true}});assert.equal(Object.values((await indexWorkspace(root)).items).flat().length,6);
 await writeFile(join(root,g.folder,'notes/my-new-note.md'),'A personal note added after archiving.');
 assert.equal(Object.values((await indexWorkspace(root)).items).flat().length,7);assert.equal((await modePreview(root)).protectedWorkspaces.length,7);
});
test('a personal session prevents a restored sample project from being archived again',async t=>{
 const {root,data}=await fixture(t);await start(root,{archive:{...archive,workspaces:true}});
 await start(root,{archive:{...archive,workspaces:false}});
 await new SessionService({workspace:root}).save({id:randomUUID(),expectedRevision:1,date:'2026-10-22',ownerPath:data.items.research[0].path,workedOn:'My actual work',outcome:'A personal observation',blockers:'',nextStep:'Check a detail',files:[]});
 await start(root,{archive:{...archive,workspaces:true}});
 const index=await indexWorkspace(root);assert.equal(index.items.research.length,1);assert.equal(index.records.sessions.items.length,1);assert.equal(index.items.research[0].path,data.items.research[0].path);
});

test('Inbox sample archiving preserves originals, personal additions and reversible visibility',async t=>{
 const {root,data}=await fixture(t),path=data.inbox[0].path,before=await readFile(join(root,path)),ideas=await readFile(join(root,'inbox/.ideas.json'));
 const {createInboxIdea,uploadInboxFile}=await import('../app/workspace.mjs');
 await createInboxIdea(root,{text:'My own new idea'});
 await uploadInboxFile(root,'my-note.txt',Buffer.from('A personal note.'));
 await assert.rejects(start(root,{archive:{...archive,inbox:'true'}}),{status:400});
 await start(root,{archive:{...archive,workspaces:true,inbox:true}});
 let index=await indexWorkspace(root);assert.equal(index.counts.inbox,2);assert.equal(index.ideas[0].text,'My own new idea');assert.equal(index.inbox[0].name,'my-note.txt');assert.equal(index.counts.research,0);
 assert.deepEqual(await readFile(join(root,path)),before);assert.ok((await readFile(join(root,'inbox/.ideas.json'),'utf8')).includes(JSON.parse(ideas).ideas[0].id));
 const preview=await modePreview(root);assert.equal(preview.groups.inboxFiles[0].archived,true);assert.equal(preview.groups.inboxIdeas[0].archived,true);
 await start(root,{archive:{...archive,workspaces:true,inbox:false}});index=await indexWorkspace(root);assert.equal(index.counts.inbox,4);assert.equal(index.counts.research,0);
});
test('edited Inbox sample ideas and file notes automatically reappear while archived',async t=>{
 const {root,data}=await fixture(t);await start(root,{archive:{...archive,inbox:true}});assert.equal((await indexWorkspace(root)).counts.inbox,0);
 const {updateInboxIdea}=await import('../app/workspace.mjs');const idea=data.ideas[0];await updateInboxIdea(root,{id:idea.id,expectedRevision:idea.revision,text:'My own edited idea'});
 const file=join(root,data.inbox[0].path);await writeFile(file,(await readFile(file,'utf8'))+'\nMy own addition.\n');
 const index=await indexWorkspace(root);assert.equal(index.counts.inbox,2);assert.equal(index.ideas[0].text,'My own edited idea');assert.equal((await modePreview(root)).protectedInbox.length,2);
});
test('Inbox sample files filed into a workspace stay visible',async t=>{
 const {root,data}=await fixture(t);const {fileInboxCopy}=await import('../app/materials.mjs');await fileInboxCopy(root,{path:data.inbox[0].path,ownerPath:data.items.research[0].path,folder:'notes',expectedSize:data.inbox[0].size,expectedModified:data.inbox[0].modified});
 await start(root,{archive:{...archive,inbox:true}});const index=await indexWorkspace(root);assert.equal(index.ideas.length,0);assert.equal(index.inbox.length,1);assert.equal((await modePreview(root)).protectedInbox[0].reason,'This file has been filed into a workspace.');
});

test('older mode clients cannot unintentionally restore archived projects or Inbox samples',async t=>{
 const {root}=await fixture(t);await start(root,{archive:{...archive,workspaces:true,inbox:true}});await start(root,{archive});
 const index=await indexWorkspace(root);assert.equal(index.counts.research,0);assert.equal(index.counts.courses,0);assert.equal(index.counts.learn,0);assert.equal(index.counts.inbox,0);assert.equal(index.mode.selection.workspaces,true);assert.equal(index.mode.selection.inbox,true);
});
