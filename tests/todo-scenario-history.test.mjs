import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';
import {TodoService} from '../app/todos.mjs';
import {emptyCalendar,emptyCommitments,readRecords,validateCommitments} from '../app/records.mjs';
import {buildDailyContext} from '../app/daily-context.mjs';

async function fixture(t){
 const workspace=await realpath(await mkdtemp(join(tmpdir(),'ru-todo-scenario-')));
 for(const folder of ['research','courses','learn','career','admin','personal','inbox','records'])await mkdir(join(workspace,folder));
 await writeFile(join(workspace,'records/calendar.json'),JSON.stringify(emptyCalendar()));
 await writeFile(join(workspace,'records/commitments.json'),JSON.stringify(emptyCommitments()));
 let clock='2026-04-02T02:30:00.000Z';
 const service=new TodoService({workspace,now:()=>new Date(clock)});
 const scenario=async date=>writeFile(join(workspace,'.demo.json'),JSON.stringify({version:1,synthetic:true,scenarioDate:date}));
 const create=()=>service.create({requestId:randomUUID(),title:'Check the proof outline',category:'personal',addToToday:true,expectedRevision:0});
 const change=async(action,input)=>service[action]({...input,expectedRevision:(await readRecords(workspace)).commitments.revision});
 t.after(()=>rm(workspace,{recursive:true,force:true}));
 return{workspace,service,scenario,create,change,setClock:value=>{clock=value;}};
}
async function browser(records,demo){
 const listeners=[],dialogs=[],snapshot={items:{},records,...(demo?{demo}:{})},window={RUSessions:{list:()=>'',preview:()=>''}};
 const document={addEventListener(type,listener){if(type==='click')listeners.push(listener);},querySelector:()=>null,querySelectorAll:()=>[]};
 const api={snapshot:()=>snapshot,section:()=> 'track',active:()=>false,render(){},notice(){},dialog:(title,body)=>dialogs.push({title,body})};
 for(const name of ['todo-ui.js','track-ui.js'])vm.runInNewContext(await readFile(new URL('../app/'+name,import.meta.url),'utf8'),{window,document,Intl,Date,location:{hash:'#track/history'}});
 window.RUTodos.init(api);window.RUTrack.init(api);
 return{window,dialogs,history:()=>window.RUTrack.render('history'),async click(dataset){const button={disabled:false,dataset,hasAttribute:()=>false};for(const listener of listeners)await listener({target:{closest:()=>button}});}};
}

test('synthetic Todo transitions retain real audit instants and their own scenario work dates through reopen, cancel and readers',async t=>{
 const f=await fixture(t);await f.scenario('2026-04-03');const task=await f.create(),calendarBefore=await readFile(join(f.workspace,'records/calendar.json'),'utf8');
 let row=await f.change('complete',{id:task.id,done:true});assert.equal(row.completedAt,'2026-04-02T02:30:00.000Z');assert.equal(row.history[0].at,row.completedAt);assert.equal(row.history[0].workDate,'2026-04-03');assert.equal(row.history[0].synthetic,true);
 const revision=(await readRecords(f.workspace)).commitments.revision;await f.change('complete',{id:task.id,done:true});assert.equal((await readRecords(f.workspace)).commitments.revision,revision);
 await f.scenario('2026-04-04');f.setClock('2026-04-02T02:35:00.000Z');row=await f.change('complete',{id:task.id,done:false});assert.equal(row.status,'open');assert.equal(row.completedAt,null);
 f.setClock('2026-04-02T02:40:00.000Z');await f.change('complete',{id:task.id,done:true});f.setClock('2026-04-02T02:45:00.000Z');row=await f.change('cancel',{id:task.id});
 assert.equal(row.status,'cancelled');assert.equal(row.completedAt,null);assert.deepEqual(row.history.map(h=>h.action),['completed','reopened','completed','cancelled']);assert.deepEqual(row.history.map(h=>h.workDate),['2026-04-03','2026-04-04','2026-04-04','2026-04-04']);assert.deepEqual(row.todayDates,['2026-04-03']);assert.equal(row.updatedAt,'2026-04-02T02:45:00.000Z');assert.equal(await readFile(join(f.workspace,'records/calendar.json'),'utf8'),calendarBefore);
 const records=await readRecords(f.workspace),ui=await browser(records,{scenarioDate:'2026-04-04'}),html=ui.history();assert.match(html,/data-track-day="2026-04-03"/);assert.match(html,/data-track-day="2026-04-04"/);assert.doesNotMatch(html,/data-track-day="2026-04-01"/);
 await ui.click({trackPreview:'activity',trackPreviewDate:'2026-04-04'});assert.match(ui.dialogs.at(-1).body,/Synthetic example · Reopen \/ Change status/);assert.match(ui.dialogs.at(-1).body,/Recorded Apr 1/);assert.match(ui.dialogs.at(-1).body,/datetime="2026-04-02T02:35:00.000Z"/);assert.match(ui.dialogs.at(-1).body,/Cancelled · Check the proof outline/);
 await ui.click({todoFilter:'done'});assert.match(ui.window.RUTodos.render(),/datetime="2026-04-04" title="Synthetic work date 2026-04-04 · Recorded 2026-04-02T02:45:00.000Z"/);await ui.click({todoView:task.id});assert.match(ui.dialogs.at(-1).body,/Synthetic work date 2026-04-03/);assert.match(ui.dialogs.at(-1).body,/Recorded Apr 1/);
 const output=await buildDailyContext({workspaceRoot:f.workspace,context:{section:'track',view:{trackTab:'todos',todoFilter:'all',selectedTodoId:task.id}}}),context=JSON.parse(output.slice(output.indexOf('\n')+1));assert.equal(context.selection.todo.savedRecord.history.items[0].workDate,'2026-04-03');assert.equal(context.selection.todo.savedRecord.history.items[0].at,'2026-04-02T02:30:00.000Z');assert.equal(context.selection.todo.savedRecord.history.items[0].synthetic,true);
});

test('real and legacy Todo histories keep local audit-date grouping, and leaving demo mode does not rewrite saved scenario history',async t=>{
 const real=await fixture(t),task=await real.create(),completed=await real.change('complete',{id:task.id,done:true});assert.equal(completed.history[0].workDate,undefined);assert.equal(completed.history[0].synthetic,undefined);
 let ui=await browser(await readRecords(real.workspace));assert.match(ui.history(),/data-track-day="2026-04-01"/);
 const demo=await fixture(t);await demo.scenario('2026-04-03');const sample=await demo.create();await demo.change('complete',{id:sample.id,done:true});await writeFile(join(demo.workspace,'.demo.json'),JSON.stringify({version:1,mode:'daily',synthetic:false,startedAt:'2026-04-02T02:31:00.000Z',archived:{}}));demo.setClock('2026-04-02T02:35:00.000Z');const reopened=await demo.change('complete',{id:sample.id,done:false});assert.equal(reopened.history[0].workDate,'2026-04-03');assert.equal(reopened.history[1].workDate,undefined);assert.equal(reopened.history[1].synthetic,undefined);
 ui=await browser(await readRecords(demo.workspace));assert.match(ui.history(),/data-track-day="2026-04-03"/);assert.match(ui.history(),/data-track-day="2026-04-01"/);
 const legacy=structuredClone(await readRecords(real.workspace));legacy.commitments.items[0].history[0].synthetic=true;assert.doesNotThrow(()=>validateCommitments(legacy.commitments));ui=await browser(legacy);assert.match(ui.history(),/data-track-day="2026-04-01"/);
 for(const patch of [{workDate:'2026-02-30',synthetic:true},{workDate:'2026-04-03',synthetic:false},{workDate:'2026-04-03'}]){const invalid=structuredClone(await readRecords(real.workspace));Object.assign(invalid.commitments.items[0].history[0],patch);assert.throws(()=>validateCommitments(invalid.commitments),/completion history/);}
});
