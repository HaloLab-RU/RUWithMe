import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {once} from 'node:events';
import vm from 'node:vm';
import {SessionService} from '../app/sessions.mjs';
import {TrackService} from '../app/track.mjs';
import {readSessions,readTrack,emptySessions,emptyCalendar,emptyCommitments,weekStart,shiftDate} from '../app/records.mjs';
import {indexWorkspace} from '../app/workspace.mjs';
import {buildDailyContext} from '../app/daily-context.mjs';
import {createRequestHandler} from '../app/server.mjs';
import {createDailyRecordsTools} from '../app/daily-records-mcp.mjs';
const fixed=()=>new Date('2026-10-21T16:00:00Z');
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'ru-sessions-weekly-')),workspace=join(root,'workspace'),ownerPath='research/Sample/README.md';
 for(const path of ['research/Sample/notes','research/Sample/files','courses','learn','career','admin','personal','inbox','records/days'])await mkdir(join(workspace,path),{recursive:true});
 await writeFile(join(workspace,ownerPath),'---\ntitle: Sample\nnext: "User-maintained context"\n---\nOriginal project context.');
 await writeFile(join(workspace,'research/Sample/files/derivation.pdf'),'ORIGINAL_PDF_BYTES');
 for(const [name,data] of [['calendar',emptyCalendar()],['commitments',emptyCommitments()]])await writeFile(join(workspace,'records',name+'.json'),JSON.stringify(data));
 const daily={csrf:'test-csrf',active:null,data:{messages:[]},load:async()=>{},status:async()=>({csrf:'test-csrf'}),startTurn:async(input,options)=>{daily.calls.push({input,options});return{active:true};},calls:[]};
 t.after(()=>rm(root,{recursive:true,force:true}));return{root,workspace,ownerPath,daily,sessions:new SessionService({workspace,now:fixed}),track:new TrackService({workspace,daily,projectRoot:root,now:fixed})};
}
function session(f,extra={}){return{id:randomUUID(),expectedRevision:0,date:'2026-10-21',ownerPath:f.ownerPath,workedOn:'Tried the alternative bound.',outcome:'An extra variance term remains.',blockers:'Need an assumption check.',nextStep:'Inspect Lemma 2.',files:['research/Sample/files/derivation.pdf'],...extra};}
const review={progress:['User reported testing the alternative bound.'],unfinished:['Resolve the variance term.'],blockers:['Assumption check remains open.'],nextWeek:['Discuss the assumption with the advisor.'],oneLine:'Tested a bound and identified an unresolved assumption.'};

test('sessions are durable, project-linked actual-work reports; corrections preserve previous versions and do not mutate other stores',async t=>{
 const f=await fixture(t),protectedPaths=[f.ownerPath,'research/Sample/files/derivation.pdf','records/calendar.json','records/commitments.json'],before=await Promise.all(protectedPaths.map(p=>readFile(join(f.workspace,p),'utf8')));
 assert.deepEqual(await readSessions(f.workspace),emptySessions());assert.ok(!(await readdir(join(f.workspace,'records'))).includes('sessions.json'));
 const input=session(f),saved=await f.sessions.save(input);assert.equal(saved.ownerPath,f.ownerPath);assert.equal(saved.revision,1);
 assert.deepEqual(await f.sessions.save(input),saved);assert.equal((await readSessions(f.workspace)).items.length,1);
 const edit=await f.sessions.save({...input,expectedRevision:1,expectedItemRevision:1,outcome:'Corrected: the term is bounded under the stronger assumption.'});assert.equal(edit.revision,2);assert.equal(edit.versions[0].outcome,input.outcome);assert.equal(edit.versions[0].revision,1);
 await assert.rejects(f.sessions.save({...input,expectedRevision:1,expectedItemRevision:1}),e=>e.status===409);
 const restored=await readSessions(f.workspace);assert.deepEqual(restored.items,[edit]);assert.equal(restored.revision,2);
 assert.deepEqual(await Promise.all(protectedPaths.map(p=>readFile(join(f.workspace,p),'utf8'))),before);
 const context=await buildDailyContext({workspaceRoot:f.workspace,context:{section:'research',sourcePath:f.ownerPath}});assert.ok(context.includes('Inspect Lemma 2.'));assert.ok(context.includes('Corrected:'));assert.ok(!context.includes('An extra variance term remains.'));
});
test('sessions reject future work, unknown owners, private paths, symlink escapes and conflicting concurrent writes',async t=>{
 const f=await fixture(t);for(const extra of [{date:'2026-10-22'},{date:'2026-02-30'},{ownerPath:'research/Absent/README.md'},{workedOn:''},{files:['../private.pdf']},{files:['inbox/.secret.json']}])await assert.rejects(f.sessions.save(session(f,extra)));
 const outside=join(f.root,'private.pdf');await writeFile(outside,'PRIVATE');await symlink(outside,join(f.workspace,'research/Sample/files/escape.pdf'));
 await assert.rejects(f.sessions.save(session(f,{files:['research/Sample/files/escape.pdf']})),/outside/);
 const results=await Promise.allSettled([f.sessions.save(session(f)),f.sessions.save(session(f))]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);assert.equal((await readSessions(f.workspace)).items.length,1);
 const file=join(f.workspace,'records/sessions.json');await rm(file);await symlink(outside,file);await assert.rejects(f.sessions.save(session(f)),/symbolic/);assert.equal(await readFile(outside,'utf8'),'PRIVATE');
});
test('weekly review has timezone-safe Monday/Sunday scope, supports past weeks, and requires explicit later consent',async t=>{
 assert.equal(weekStart('2026-11-01'),'2026-10-26');assert.equal(shiftDate('2026-10-26',6),'2026-11-01');assert.equal(weekStart('2027-01-01'),'2026-12-28');
 const f=await fixture(t);await f.track.start({type:'weekly',date:'2026-10-21',requestId:randomUUID()},'http://127.0.0.1:4191');assert.match(f.daily.calls[0].input.text,/2026-10-19 through 2026-10-25/);assert.match(f.daily.calls[0].input.text,/week is in progress/);assert.match(f.daily.calls[0].input.text,/ruwithme-weekly-review/);
 await f.track.start({type:'weekly',date:'2026-10-11',requestId:randomUUID()},'http://127.0.0.1:4191');assert.match(f.daily.calls[1].input.text,/2026-10-05 through 2026-10-11/);await assert.rejects(f.track.start({type:'weekly',date:'2026-10-26',requestId:randomUUID()},'http://127.0.0.1:4191'),/Future weeks/);assert.equal((await readTrack(f.workspace)).entries.length,0);
 await assert.rejects(f.track.propose({requestId:randomUUID(),expectedRevision:0,date:'2026-10-21',type:'weekly',content:review}));
 await assert.rejects(f.track.propose({requestId:randomUUID(),expectedRevision:0,date:'2026-10-26',type:'weekly',content:review}),/Future weeks/);
 const draft=await f.track.propose({requestId:randomUUID(),expectedRevision:0,date:'2026-10-19',type:'weekly',content:review}),confirm={id:draft.id,expectedRevision:1,expectedDraftRevision:1,confirmationMessageId:'approval'};
 f.daily.data.messages=[{id:'approval',role:'user',text:'Confirm and save after adding another result',time:'2026-10-21T16:01:00Z'}];await assert.rejects(f.track.confirm(confirm),e=>e.status===409);
 f.daily.data.messages=[{id:'approval',role:'user',text:'Confirm and save',time:'2026-10-21T16:02:00Z'}];const entry=await f.track.confirm(confirm);assert.equal(entry.type,'weekly');assert.equal(entry.date,'2026-10-19');assert.deepEqual(entry.content,review);assert.equal((await indexWorkspace(f.workspace)).records.commitments.items.length,0);
});
test('local MCP and HTTP preserve session revisions, CSRF and weekly confirmation contracts',async t=>{
 const f=await fixture(t);let handler;const server=http.createServer((req,res)=>handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port,origin='http://127.0.0.1:'+port;handler=createRequestHandler({workspace:f.workspace,daily:f.daily,port});t.after(()=>new Promise(done=>{server.closeAllConnections();server.close(done);}));
 const post=(input,headers={})=>fetch(origin+'/api/sessions/save',{method:'POST',headers:{Origin:origin,'X-RUWithMe-CSRF':'test-csrf','Content-Type':'application/json',...headers},body:JSON.stringify(input)});
 for(const headers of [{Origin:'https://other.invalid'},{Origin:''},{'X-RUWithMe-CSRF':'wrong'}]){const r=await post(session(f),headers);assert.equal(r.status,403);await r.text();}
 let r=await post(session(f));assert.equal(r.status,200);await r.json();r=await fetch(origin+'/api/sessions');assert.equal((await r.json()).items.length,1);
 r=await post({text:'x'.repeat(65000)});assert.equal(r.status,413);await r.text();r=await post({}, {'Content-Type':'text/plain'});assert.equal(r.status,415);await r.text();
 const call=createDailyRecordsTools({origin});const state=await call('read_records',{});assert.equal(state.workspace.records.sessions.items.length,1);
 const d=await call('propose_track',{requestId:randomUUID(),expectedRevision:0,date:'2026-10-19',type:'weekly',content:review});assert.equal(d.type,'weekly');assert.equal(d.status,'pending');await assert.rejects(call('confirm_track',{id:d.id,expectedRevision:1,expectedDraftRevision:1,confirmationMessageId:'not-confirmed'}),/409/);
});
test('freshness labels preserve source timestamps and present courses as manual workspaces',async()=>{
 const context={window:{},Intl,Date};vm.runInNewContext(await readFile(new URL('../app/freshness-ui.js',import.meta.url),'utf8'),context);
 const snapshot={records:{calendar:{timeZone:'America/New_York',sources:[{title:'<unsafe>',provider:'google',lastSyncedAt:'2026-10-21T15:00:00Z',window:{startAt:'2026-10-01T00:00:00Z',endAt:'2026-11-01T00:00:00Z'}},{title:'Older',provider:'google',lastSyncedAt:'2026-10-20T15:00:00Z'}]}},items:{courses:[{title:'Course',canvas:{syncedAt:'2026-10-19T14:00:00Z'}}]}};
 const summary=context.window.RUFreshness.summary(snapshot);assert.match(summary,/Oldest saved capture/);assert.match(summary,/Oct 20, 2026/);assert.match(summary,/manually maintained workspaces/);assert.doesNotMatch(summary,/Canvas/);
 const detail=context.window.RUFreshness.calendar(snapshot);assert.ok(detail.includes('&lt;unsafe&gt;'));assert.ok(!detail.includes('<unsafe>'));assert.match(detail,/exclusive end/);assert.match(context.window.RUFreshness.courses(snapshot),/Last checked/);assert.match(context.window.RUFreshness.summary({}),/External sync optional/);
});
