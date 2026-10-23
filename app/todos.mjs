import {open,unlink,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readCalendar,readCommitments,validateCommitments,validDate,validInstant} from './records.mjs';
import {commitCalendar,ensureCalendarFolder,writePrivateJSON} from './google-calendar.mjs';
import {safeFile} from './workspace.mjs';
import {connectorData} from './codex-calendar.mjs';
import {workspaceDay,readDemo} from './demo.mjs';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const revision=value=>Number.isSafeInteger(value)&&value>=0;
const categories=['research','courses','learn','career','admin','personal','other'];
export function localDate(now,timeZone){return new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);}
function parts(at,timeZone){return Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(at)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));}
export function zonedInstant(value,timeZone){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)||!validDate(value.slice(0,10)))throw fail('Choose a valid date and time.');
 try{new Intl.DateTimeFormat('en',{timeZone});}catch{throw fail('Choose a valid IANA time zone.');}
 const target=Date.parse(value+':00Z'),offsets=new Set();
 for(let hour=-36;hour<=36;hour+=6){const at=target+hour*36e5,p=parts(at,timeZone);offsets.add(Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`)-at);}
 const matches=[...offsets].map(offset=>target-offset).filter(at=>{const p=parts(at,timeZone);return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`===value;});
 if(matches.length!==1)throw fail(matches.length?'This time is ambiguous during a daylight saving transition. Choose an unambiguous time.':'This time does not exist during the daylight saving transition. Choose another time.');
 return new Date(matches[0]).toISOString();
}
export async function withCommitments(root,expectedRevision,transform){
 if(!revision(expectedRevision))throw fail('Refresh before changing Todos or commitments.');
 const base=await realpath(root),dir=resolve(base,'records');await ensureCalendarFolder(dir);let lock;
 try{
  try{lock=await open(resolve(dir,'.commitments.lock'),'wx',0o600);}catch(e){if(e.code==='EEXIST')throw fail('Todos and commitments are being updated. Try again shortly.',409);throw e;}
  const store=await readCommitments(base);if(store.revision!==expectedRevision)throw fail('Todos and commitments have changed. Your draft is preserved. Refresh and review before saving.',409);
  const result=await transform(store);if(result.unchanged)return result.value;
  store.revision++;validateCommitments(store);await writePrivateJSON(resolve(dir,'commitments.json'),store);return result.value;
 }finally{if(lock){await lock.close();await unlink(resolve(dir,'.commitments.lock')).catch(()=>{});}}
}
export function moveDeleted(workspace,input,{todo,restore=false,now=()=>new Date()}={}){
 return withCommitments(workspace,input.expectedRevision,store=>{
  const matches=row=>row.id===input.id&&(todo?row.kind==='todo':row.kind!=='todo');
  const source=restore?(store.trash||[]):store.items,target=restore?store.items:(store.trash||[]),index=source.findIndex(matches);
  if(index<0){const existing=target.find(matches);if(existing)return{unchanged:true,value:existing};throw fail('This item is no longer available. Refresh the list.',404);}
  const row=source[index];if(restore&&store.items.some(r=>r.id===row.id))throw fail('This record identity is already in use.',409);
  const moved={...row,revision:(row.revision||0)+1,updatedAt:now().toISOString()};
  if(restore)delete moved.deletedAt;else moved.deletedAt=now().toISOString();
  source.splice(index,1);target.push(moved);if(!restore)store.trash=target;
  return{value:moved};
 });
}
function findTodo(store,id){const task=store.items.find(t=>t.id===id&&t.kind==='todo');if(!task)throw fail('This Todo no longer exists. Refresh the list.',404);return task;}
async function transitionHistory(workspace,action,at){const demo=await readDemo(workspace);return{id:randomUUID(),action,at,...(demo?{synthetic:true,workDate:demo.scenarioDate}:{})};}
async function fields(root,input){
 if(typeof input.title!=='string'||!input.title.trim()||input.title.trim().length>1000)throw fail('Enter a Todo of 1–1,000 characters.');
 const category=input.category||'personal';if(!categories.includes(category))throw fail('Choose a valid Todo category.');
 const dueDate=input.dueDate||null;if(dueDate&&!validDate(dueDate))throw fail('Choose a valid deadline date.');
 const ownerPath=input.ownerPath||null;if(ownerPath){if(typeof ownerPath!=='string'||!ownerPath.startsWith((category==='other'?'personal':category)+'/')||!ownerPath.endsWith('/README.md'))throw fail('The linked workspace does not match the Todo category.');await safeFile(root,ownerPath);}
 const extra={};
 if(Object.hasOwn(input,'parentCommitmentId')){if(input.parentCommitmentId!==null&&input.parentCommitmentId!==''&&(typeof input.parentCommitmentId!=='string'||input.parentCommitmentId.length>120))throw fail('Choose a parent Commitment.');extra.parentCommitmentId=input.parentCommitmentId||null;}
 if(Object.hasOwn(input,'estimateMinutes')){const estimate=input.estimateMinutes===null||input.estimateMinutes===''?null:Number(input.estimateMinutes);if(estimate!==null&&(!Number.isInteger(estimate)||estimate<5||estimate>1440))throw fail('Estimate between 5 and 1,440 minutes.');extra.estimateMinutes=estimate;}
 return{title:input.title.trim(),category,dueDate,ownerPath,...extra};
}
function validateParent(store,data,existing){if(!data.parentCommitmentId)return;const parent=store.items.find(row=>row.id===data.parentCommitmentId&&row.kind!=='todo');if(!parent&&existing?.parentCommitmentId!==data.parentCommitmentId)throw fail('The parent Commitment is no longer available. Choose another one.',409);}
export class TodoService{
 constructor({workspace,google,now=()=>new Date()}){this.workspace=workspace;this.google=google;this.now=now;}
 async delete(input){return moveDeleted(this.workspace,input,{todo:true,now:this.now});}
 async restore(input){return moveDeleted(this.workspace,input,{todo:true,restore:true,now:this.now});}
 async create(input){
  if(!uuid(input.requestId))throw fail('Use a new Todo request ID.');const data=await fields(this.workspace,input);
  return withCommitments(this.workspace,input.expectedRevision,async store=>{
   const existing=[...store.items,...(store.trash||[])].find(t=>t.id===input.requestId);if(existing){if(existing.kind!=='todo')throw fail('Todo ID conflict.',409);if(existing.deletedAt)throw fail('This Todo was deleted. Restore it from Deleted instead of recreating it.',409);return{unchanged:true,value:existing};}
   validateParent(store,data);const at=this.now().toISOString(),calendar=await readCalendar(this.workspace),task={id:input.requestId,kind:'todo',revision:1,...data,status:'open',createdAt:at,updatedAt:at,completedAt:null,todayDates:input.addToToday?[await workspaceDay(this.workspace,this.now(),calendar.timeZone)]:[],history:[]};store.items.push(task);return{value:task};
  });
 }
 async update(input){const data=await fields(this.workspace,input);return withCommitments(this.workspace,input.expectedRevision,store=>{const task=findTodo(store,input.id);validateParent(store,data,task);Object.assign(task,data,{updatedAt:this.now().toISOString(),revision:task.revision+1});return{value:task};});}
 async today(input){
  if(typeof input.selected!=='boolean')throw fail('Choose whether to add this Todo to Today.');
  const calendar=await readCalendar(this.workspace),day=await workspaceDay(this.workspace,this.now(),calendar.timeZone);
  return withCommitments(this.workspace,input.expectedRevision,store=>{const task=findTodo(store,input.id);if(['done','cancelled'].includes(task.status)&&input.selected)throw fail('This Todo is closed. Reopen it first.',409);const dates=new Set(task.todayDates);if(input.selected)dates.add(day);else dates.delete(day);task.todayDates=[...dates].sort();task.updatedAt=this.now().toISOString();task.revision++;return{value:task};});
 }
 async complete(input){
  if(typeof input.done!=='boolean')throw fail('Choose a completion state.');
  return withCommitments(this.workspace,input.expectedRevision,async store=>{const task=findTodo(store,input.id);if(input.done?task.status==='done':task.status==='open')return{unchanged:true,value:task};const at=this.now().toISOString(),history=await transitionHistory(this.workspace,input.done?'completed':'reopened',at);task.status=input.done?'done':'open';task.completedAt=input.done?at:null;task.updatedAt=at;task.revision++;task.history.push(history);return{value:task};});
 }
 async cancel(input){return withCommitments(this.workspace,input.expectedRevision,async store=>{const task=findTodo(store,input.id);if(task.status==='cancelled')return{unchanged:true,value:task};const at=this.now().toISOString(),history=await transitionHistory(this.workspace,'cancelled',at);task.status='cancelled';task.completedAt=null;task.updatedAt=at;task.revision++;task.history.push(history);return{value:task};});}
 async schedule(input){
  if(!uuid(input.requestId)||!revision(input.expectedRevision)||!revision(input.expectedCalendarRevision))throw fail('Refresh before scheduling work.');
  return withCommitments(this.workspace,input.expectedRevision,async commitments=>{
   const task=findTodo(commitments,input.id);if(task.status==='done'||task.status==='cancelled')throw fail('Reopen this Todo first.',409);
   const calendar=await readCalendar(this.workspace),startAt=zonedInstant(input.startLocal,calendar.timeZone),endAt=zonedInstant(input.endLocal,calendar.timeZone);
   if(Date.parse(endAt)<=Date.parse(startAt))throw fail('The end time must be later than the start time.');
   const block={id:input.requestId,title:task.title,commitmentId:task.id,ownerPath:task.ownerPath,timeZone:calendar.timeZone,startAt,endAt,status:'planned',createdAt:this.now().toISOString()};
   await commitCalendar(this.workspace,input.expectedCalendarRevision,current=>{
    if(current.workBlocks.some(b=>b.id===block.id))throw fail('This work block is already saved. Refresh to view it.',409);current.workBlocks.push(block);current.revision++;return current;
   });return{unchanged:true,value:block};
  });
 }
 async cancelBlock(input){
  await commitCalendar(this.workspace,input.expectedCalendarRevision,current=>{const block=current.workBlocks.find(b=>b.id===input.id);if(!block)throw fail('This work block does not exist.',404);if(block.google)throw fail('This block is linked to Google. Adjust it in Google Calendar; it will not be deleted locally.',409);block.status='cancelled';current.revision++;return current;});return{cancelled:true};
 }
 async patchPublish(id,operationId,patch){
  const current=await readCalendar(this.workspace);
  return commitCalendar(this.workspace,current.revision,calendar=>{const block=calendar.workBlocks.find(b=>b.id===id);if(!block||block.google?.operationId!==operationId)throw fail('The publication record changed. Review it again.',409);Object.assign(block.google,patch);calendar.revision++;return calendar;});
 }
 async publish(input){
  if(await readDemo(this.workspace))throw fail('Sample work blocks stay local. Use a personal workspace to publish real events.',409);
  if(input.confirmed!==true||!uuid(input.operationId)||typeof input.calendarId!=='string'||typeof input.account!=='string')throw fail('Review the Google calendar and work block before publishing.');
  return this.google.exclusive(async()=>{
   const calendar=await readCalendar(this.workspace);if(calendar.revision!==input.expectedCalendarRevision)throw fail('The calendar changed. Review the publication preview again.',409);
   const block=calendar.workBlocks.find(b=>b.id===input.id);if(!block||block.status!=='planned')throw fail('The work block to publish was not found.',404);
   const tasks=await readCommitments(this.workspace),sourceTask=[...tasks.items,...(tasks.trash||[])].find(row=>row.id===block.commitmentId);
   if(block.synthetic===true||sourceTask?.synthetic===true)throw fail('Sample work blocks stay local, including in daily mode.',409);
   if(block.google)throw fail('This block already has a publication record. Use Check Google to avoid creating a duplicate.',409);
   const data=await this.google.discover(true),target=data.calendars.find(c=>c.id===input.calendarId&&c.writable);
   if(!data.canCreate||!target||data.account!==input.account)throw fail('The Google account or writable calendar changed. Refresh the preview.',409);
   const marker='RUWithMe work block '+block.id,google={state:'publishing',operationId:input.operationId,account:data.account,calendarId:target.id,calendarTitle:target.title,marker,startedAt:this.now().toISOString()};
   await commitCalendar(this.workspace,calendar.revision,current=>{const found=current.workBlocks.find(b=>b.id===block.id);if(found.google)throw fail('This work block is being published.',409);found.google=google;current.revision++;return current;});
   try{
    const created=connectorData(await this.google.daily.createCalendarWorkBlock({title:block.title,attendees:[],self_attendance:'omit',add_google_meet:false,calendar_id:target.id,timezone_str:block.timeZone,start_time:block.startAt,end_time:block.endAt,description:marker}));
    const event=created.event||created;if(typeof event.id!=='string'||!event.id)throw fail('Google did not return an event ID. Use Check Google to verify; do not publish again.',502);
    await this.patchPublish(block.id,google.operationId,{eventId:event.id,state:'verifying'});
    return this.checkPublished(block.id,google.operationId);
   }catch(e){await this.patchPublish(block.id,google.operationId,{state:'uncertain'}).catch(()=>{});throw fail('Publication is not confirmed. Use Check Google to verify and avoid duplicates.'+(e.message?/\u62d2\u7edd|denied|approval|review/i.test(e.message)?' '+e.message:'':''),502);}
  });
 }
 async checkPublished(id,operationId){
  const calendar=await readCalendar(this.workspace),block=calendar.workBlocks.find(b=>b.id===id),g=block?.google;if(!g||g.operationId!==operationId)throw fail('The publication record does not exist.',404);
  const data=await this.google.discover(true);if(data.account!==g.account)throw fail('Switch back to the Google account used for publication.',409);
  let event;
  if(g.eventId)event=connectorData(await this.google.daily.readCalendarWorkBlock({calendar_id:g.calendarId,event_id:g.eventId}));
  else{
   const matches=[];let cursor;const tokens=new Set();
   do{if(tokens.has(cursor||'')||tokens.size>=100)throw fail('Google verification pagination did not finish.',502);tokens.add(cursor||'');const page=await this.google.call('search_events',{calendar_id:g.calendarId,time_min:block.startAt,time_max:block.endAt,timezone_str:block.timeZone,query:g.marker,max_results:250,...(cursor?{next_page_token:cursor}:{})});if(!Array.isArray(page.events))throw fail('Google verification returned incomplete results.',502);matches.push(...page.events.filter(e=>e.description?.includes(g.marker)));cursor=page.next_page_token;}while(cursor);
   if(matches.length!==1)throw fail(matches.length?'Multiple matching events were found. Verify them in Google; this block will not be published again.':'No matching event was found yet. Use Check Google again later; creation will not be retried automatically.',409);
   event=connectorData(await this.google.daily.readCalendarWorkBlock({calendar_id:g.calendarId,event_id:matches[0].id}));
  }
  event=event.event||event;
  const start=typeof event.start==='string'?event.start:event.start?.dateTime,end=typeof event.end==='string'?event.end:event.end?.dateTime;
  if(event.status==='cancelled'||!event.id||event.summary!==block.title||Date.parse(start)!==Date.parse(block.startAt)||Date.parse(end)!==Date.parse(block.endAt))throw fail('The Google event differs from the local work block. Check it in Google; it will not be overwritten.',409);
  let sourceUrl;try{const url=new URL(event.url||event.htmlLink);if(url.protocol==='https:'&&!url.username&&!url.password&&['www.google.com','calendar.google.com'].includes(url.hostname))sourceUrl=url.href;}catch{}
  await this.patchPublish(id,operationId,{state:'published',eventId:event.id,verifiedAt:this.now().toISOString(),...(sourceUrl?{sourceUrl}:{})});return{published:true,eventId:event.id};
 }
 async reconcile(input){return this.google.exclusive(async()=>{const c=await readCalendar(this.workspace),b=c.workBlocks.find(b=>b.id===input.id);if(!b?.google)throw fail('This work block has no publication record.',404);return this.checkPublished(b.id,b.google.operationId);});}
}
export async function handleTodoRequest(req,res,{service,daily,origin,json}){
 const path=new URL(req.url,origin).pathname;if(!path.startsWith('/api/todos/'))return false;
 const actions={create:'create',update:'update',today:'today',complete:'complete',cancel:'cancel',delete:'delete',restore:'restore',schedule:'schedule','cancel-block':'cancelBlock',publish:'publish','check-google':'reconcile'},key=path.slice('/api/todos/'.length);
 if(!Object.hasOwn(actions,key)){json(res,404,{error:'Not found'});return true;}
 if(req.method!=='POST'){json(res,405,{error:'Method not allowed'});return true;}
 if(req.headers.origin!==origin||req.headers['x-ruwithme-csrf']!==daily.csrf){json(res,403,{error:'Refresh before changing a Todo.'});return true;}
 if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json'){json(res,415,{error:'JSON required'});return true;}
 const chunks=[];let size=0;for await(const chunk of req.iterator({destroyOnReturn:false})){size+=chunk.length;if(size>16000){req.resume();json(res,413,{error:'Request too large'});return true;}chunks.push(chunk);}
 const input=JSON.parse(Buffer.concat(chunks,size).toString('utf8'));if(!input||typeof input!=='object'||Array.isArray(input))throw fail('A JSON object is required.');
 json(res,200,await service[actions[key]](input));return true;
}
