import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {buildDailyContext,DAILY_CONTEXT_MAX_CHARS} from '../app/daily-context.mjs';
import {emptyCalendar} from '../app/records.mjs';

const when='2026-10-20T18:00:00.000Z';
const commitment=(id,extra={})=>({id,kind:'commitment',title:'Saved '+id,category:'research',status:'open',revision:1,createdAt:when,updatedAt:when,history:[],...extra});
const todo=(id,extra={})=>({...commitment(id),kind:'todo',todayDates:[],completedAt:null,...extra});
async function fixture(t,items,trash=[]){
 const root=await realpath(await mkdtemp(join(tmpdir(),'ru-track-commitments-context-')));
 for(const folder of ['research','courses','learn','career','admin','personal','inbox','records'])await mkdir(join(root,folder));
 const store={version:1,revision:7,items,trash};
 await writeFile(join(root,'records/commitments.json'),JSON.stringify(store));
 await writeFile(join(root,'records/calendar.json'),JSON.stringify(emptyCalendar()));
 t.after(()=>rm(root,{recursive:true,force:true}));
 return{root,store};
}
async function context(root,view={},extra={}){
 const output=await buildDailyContext({workspaceRoot:root,context:{section:'track',view:{trackTab:'commitments',...view},...extra}});
 assert.ok(output.length<=DAILY_CONTEXT_MAX_CHARS);
 const value=JSON.parse(output.slice(output.indexOf('\n')+1));
 assert.equal(value.status,'ready');
 return{output,value};
}

test('Track Commitments canonical list matches every UI filter and spans dates',async t=>{
 const active=commitment('active-later',{dueDate:'2027-01-01'}),earlier=commitment('active-earlier',{status:'waiting',dueDate:'2020-01-01'}),legacy={id:'legacy',title:'Legacy responsibility',category:'research',status:'in-progress'},done=commitment('done',{status:'done',completedAt:when}),cancelled=commitment('cancelled',{status:'cancelled',updatedAt:'2026-10-21T18:00:00Z'}),deleted=commitment('deleted',{status:'waiting',deletedAt:'2026-10-21T18:00:00Z'}),deletedOlder=commitment('deleted-older',{status:'done',deletedAt:when});
 const {root,store}=await fixture(t,[active,done,todo('open-todo'),cancelled,earlier,legacy],[deletedOlder,todo('deleted-todo',{deletedAt:when}),deleted]);
 const before=await readFile(join(root,'records/commitments.json'),'utf8'),listeners=[],ui={window:{},document:{addEventListener:(name,fn)=>listeners.push(fn)},Intl,Date};
 vm.runInNewContext(await readFile(new URL('../app/commitment-ui.js',import.meta.url),'utf8'),ui);
 ui.window.RUCommitments.init({snapshot:()=>({items:{},records:{commitments:store,calendar:emptyCalendar()}}),render(){}});
 for(const filter of ['active','archived','deleted']){
  await listeners[0]({target:{closest:()=>({disabled:false,dataset:{cmFilter:filter},hasAttribute:()=>false})}});
  const browserView=ui.window.RUCommitments.context();assert.equal(browserView.commitmentFilter,filter);
  const visibleIds=[...ui.window.RUCommitments.dashboard().matchAll(/data-cm-view="([^"]+)"/g)].map(match=>match[1]);
  for(const trackDate of ['2020-01-01','2027-01-01']){
   const {value}=await context(root,{...browserView,trackDate});
   assert.equal(value.page.view.trackTab,'commitments');assert.equal(value.page.view.trackDate,null);assert.equal(value.page.view.commitmentFilter,filter);
   assert.equal(value.records.scope,'saved non-Todo commitments matching '+filter+' across all dates');
   assert.equal(value.records.commitmentsRevision,7);assert.equal(value.records.totalCommitments,5);assert.equal(value.records.todos.total,0);
   const visible=filter==='deleted'?value.records.deletedCommitments:value.records.commitments;
   assert.deepEqual(visible.items.map(row=>row.id),visibleIds);assert.equal(visible.total,visibleIds.length);
   if(filter==='deleted'){assert.equal(value.records.commitments.total,0);assert.ok(visible.items.every(row=>row.deletedAt&&/not an active responsibility/.test(row.recordState)));assert.deepEqual(visible.items.map(row=>row.status),['waiting','done']);}
  }
 }
 assert.equal(await readFile(join(root,'records/commitments.json'),'utf8'),before);
});

test('selected commitments retain source status and deletion state outside the current filter',async t=>{
 const open=commitment('open'),done=commitment('done',{status:'done',completedAt:when}),deleted=commitment('deleted',{status:'cancelled',deletedAt:when});
 const {root}=await fixture(t,[open,done,todo('todo-id')],[deleted]);
 for(const [filter,id,status,sourceStore,matches] of [['active',done.id,'done','commitments.items',false],['archived',open.id,'open','commitments.items',false],['active',deleted.id,'cancelled','commitments.trash',false],['deleted',deleted.id,'cancelled','commitments.trash',true]]){
  const {value}=await context(root,{commitmentFilter:filter,selectedCommitmentId:id});
  const selection=value.selection.commitment;assert.equal(selection.status,'resolved');assert.equal(selection.sourceStore,sourceStore);assert.equal(selection.matchesVisibleCommitmentFilter,matches);assert.equal(selection.savedRecord.id,id);assert.equal(selection.savedRecord.status,status);
  if(id===deleted.id)assert.match(selection.savedRecord.recordState,/deleted locally/);
 }
 const wrongKind=await context(root,{selectedCommitmentId:'todo-id'});assert.equal(wrongKind.value.selection.commitment.status,'not-found');
});

test('missing or invalid commitment filter defaults to canonical Active without client text or day records',async t=>{
 const open=commitment('open'),done=commitment('done',{status:'done'}),{root}=await fixture(t,[open,done]);
 await mkdir(join(root,'records/days'));await writeFile(join(root,'records/days/2026-10-20.md'),'SAVED-DAY-RECORD-UNRELATED-TO-MANAGER');
 for(const commitmentFilter of [undefined,'malicious',{filter:'deleted'}]){
  const {output,value}=await context(root,{commitmentFilter,trackDate:'2026-10-20',visibleCommitments:[{title:'FORGED-CLIENT-ROW'}]},{title:'FORGED-CLIENT-TITLE',content:'FORGED-CLIENT-CONTENT'});
  assert.equal(value.page.view.commitmentFilter,'active');assert.deepEqual(value.records.commitments.items.map(row=>row.id),[open.id]);assert.equal(value.records.savedDayRecords.total,0);assert.equal(value.track,undefined);assert.doesNotMatch(output,/FORGED-CLIENT|SAVED-DAY-RECORD-UNRELATED/);
 }
});

test('large Commitments manager context stays bounded with explicit omissions and selected details intact',async t=>{
 const items=Array.from({length:240},(_,i)=>commitment('item-'+i,{title:'Canonical commitment '+i+' '+('detailed title '.repeat(20)),dueDate:'2027-01-01'})),selected=commitment('selected-outside-active',{status:'done',deliverable:'Saved final delivery',person:'Collaborator'}),{root}=await fixture(t,[...items,selected]);
 const {value}=await context(root,{selectedCommitmentId:selected.id});
 assert.equal(value.records.commitments.total,240);assert.ok(value.records.commitments.items.length>0);assert.ok(value.records.commitments.omitted>0);assert.ok(value.omissions.some(line=>/commitments/.test(line)));
 assert.equal(value.selection.commitment.savedRecord.deliverable,'Saved final delivery');assert.equal(value.selection.commitment.savedRecord.status,'done');assert.equal(value.selection.commitment.matchesVisibleCommitmentFilter,false);
});
