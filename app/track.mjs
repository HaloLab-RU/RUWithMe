import {open,unlink,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readTrack,readRecords,validateTrack,trackContent,validDate,validInstant,readCalendar,weekStart,shiftDate} from './records.mjs';
import {ensureCalendarFolder,writePrivateJSON} from './google-calendar.mjs';
import {localDate} from './todos.mjs';
import {workspaceDay,readWorkspaceMode,dailyView} from './demo.mjs';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
export class TrackService{
 constructor({workspace,daily,projectRoot,now=()=>new Date()}){Object.assign(this,{workspace,daily,projectRoot,now});}
 async view(){await this.daily.load?.();const calendar=await readCalendar(this.workspace),records=dailyView(await readRecords(this.workspace),await readWorkspaceMode(this.workspace));return{...records.track,today:await workspaceDay(this.workspace,this.now(),calendar.timeZone),timeZone:calendar.timeZone,latestUserMessage:this.daily.data?.messages?.findLast(m=>m.role==='user')||null};}
 async change(expectedRevision,run){
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw fail('Read the current Track revision.');
  const root=await realpath(this.workspace),dir=resolve(root,'records');await ensureCalendarFolder(dir);let lock;
  try{try{lock=await open(resolve(dir,'.track.lock'),'wx',0o600);}catch(e){if(e.code==='EEXIST')throw fail('Track is being updated. Try again shortly.',409);throw e;}
   const data=await readTrack(root);if(data.revision!==expectedRevision)throw fail('Track changed. Review the latest draft and try again.',409);const result=await run(data);if(!result.unchanged){data.revision++;validateTrack(data);await writePrivateJSON(resolve(dir,'track.json'),data);}return result.value;
  }finally{if(lock){await lock.close();await unlink(resolve(dir,'.track.lock')).catch(()=>{});}}
 }
 async start(input,origin){
  if(!['plan','summary','weekly'].includes(input.type)||!uuid(input.requestId))throw fail('Choose a morning plan, evening review or weekly review.');
  if(input.type==='weekly')return this.startWeekly(input,origin);
  const {timeZone}=await readCalendar(this.workspace),date=await workspaceDay(this.workspace,this.now(),timeZone);if(input.date!==date)throw fail('Generation is available for today. Viewing history does not rewrite past records.',409);
  const skill=input.type==='plan'?'ruwithme-morning-plan':'ruwithme-evening-summary';
  const discussion=input.type==='plan'
   ?'Use ruwithme_daily.read_records to read today\'s calendar, commitments, saved workspace histories and today-selected Todos. In your first response, briefly summarize today\'s fixed schedule with local times, distinguish suggested work blocks, and state any source uncertainty. Then ask what I would like to work on today around those appointments. Stop and wait for my answer. Do not generate a proposed plan or call propose_track on this initial turn, even if the context already suggests priorities. After I answer with today\'s intentions, discuss a realistic suggested plan, show it in Daily and stage the same content with ruwithme_daily.propose_track. I will create my chosen Todos manually.'
   :'Discuss an evening review with me in English: completed work, unfinished work, blockers, and a one-sentence summary. Use ruwithme_daily.read_records to verify actual work and ask me for missing facts. Show the proposal in Daily and stage it as a Track draft with ruwithme_daily.propose_track.';
  return this.daily.startTurn({requestId:input.requestId,context:JSON.stringify({section:'track',view:{trackDate:date,trackTab:'records',trackType:input.type}}),text:`Use the $${skill} skill. First read ${resolve(this.projectRoot,'.agents/skills',skill,'SKILL.md')}.\nToday is ${date}, timezone ${timeZone}. Content root: ${this.workspace}. Local application origin: ${origin}.\n${discussion}\nKeep the conversation in English. Use the ruwithme_daily MCP tools for local records; do not use shell HTTP or request broader execution/network access. Save a confirmed daily record only after my explicit confirmation, using confirm_track. Do not write record files directly, create or complete Todos, or change Calendar.`},{displayText:input.type==='plan'?`Start today's plan (${date}): first summarize my fixed schedule and ask what I want to work on. Wait for my answer before drafting a plan. I will create Todos manually; confirm before saving.`:`Daily review (${date}): discuss what I completed, what remains unfinished, and where I am blocked. Include a one-sentence summary and confirm before saving.`});
 }
 async startWeekly(input,origin){
  const {timeZone}=await readCalendar(this.workspace),today=await workspaceDay(this.workspace,this.now(),timeZone);
  if(!validDate(input.date))throw fail('Choose a date in the week to review.');
  const start=weekStart(input.date),end=shiftDate(start,6);if(start>today)throw fail('Future weeks have no actual work to review.');
  const skill='ruwithme-weekly-review';
  return this.daily.startTurn({requestId:input.requestId,context:JSON.stringify({section:'track',view:{trackDate:start,trackTab:'weekly'}}),text:`Use the $${skill} skill. Read ${resolve(this.projectRoot,'.agents/skills',skill,'SKILL.md')}. Review ${start} through ${end}, timezone ${timeZone}, as of ${today}. ${end>today?'This week is in progress; review actual work only through today.':'This is a past week; current task states alone cannot reconstruct past progress.'} Content root: ${this.workspace}. Local origin: ${origin}. Use ruwithme_daily.read_records and propose_track, with type weekly and date ${start}. Review saved sessions (latest versions), confirmed Track records, reported outcomes, blockers, commitments and calendar constraints. Ask for missing actual-work evidence. Discuss and stage a draft; confirm only after a later explicit user confirmation. Never create Todos, change project priorities, complete commitments or sync/change external calendars as a review side effect.`},{displayText:`Weekly review (${start} – ${end}): discuss actual progress, unfinished work, blockers and next week's direction. Confirm before saving.`});
 }
 async propose(input){
  if(!validDate(input.date)||input.type==='weekly'&&weekStart(input.date)!==input.date||!uuid(input.requestId))throw fail('Enter a valid date and draft request ID.');
  const content=trackContent(input.type,input.content),calendar=await readCalendar(this.workspace);
  if(input.type==='weekly'&&input.date>await workspaceDay(this.workspace,this.now(),calendar.timeZone))throw fail('Future weeks have no actual work to review.');
  return this.change(input.expectedRevision,data=>{
   const existing=data.drafts.find(d=>d.id===input.requestId);if(existing)return{unchanged:true,value:existing};
   const at=this.now().toISOString();let draft;
   if(input.id){draft=data.drafts.find(d=>d.id===input.id);if(!draft||draft.status!=='pending'||draft.revision!==input.expectedDraftRevision)throw fail('The draft changed or was saved. Review the latest content.',409);if(draft.date!==input.date||draft.type!==input.type)throw fail('A draft\'s date and type cannot be changed.');Object.assign(draft,{content,revision:draft.revision+1,updatedAt:at});}
   else{draft={id:input.requestId,date:input.date,type:input.type,content,timeZone:calendar.timeZone,revision:1,status:'pending',createdAt:at,updatedAt:at};for(const older of data.drafts)if(older.date===draft.date&&older.type===draft.type&&older.status==='pending'){older.status='discarded';older.updatedAt=at;older.revision++;}data.drafts.push(draft);}
   return{value:draft};
  });
 }
 async confirm(input){
  await this.daily.load?.();
  return this.change(input.expectedRevision,data=>{
   const draft=data.drafts.find(d=>d.id===input.id);if(!draft||draft.revision!==input.expectedDraftRevision)throw fail('The draft changed. Review it again.',409);
   if(draft.status==='saved')return{unchanged:true,value:data.entries.find(e=>e.draftId===draft.id)};
   if(draft.status!=='pending')throw fail('This draft was discarded. Generate a new version.',409);
   let confirmation;
   if(input.confirmationMessageId){const message=this.daily.data?.messages?.findLast(m=>m.role==='user'),text=typeof message?.text==='string'?message.text.trim():'';if(!message||message.id!==input.confirmationMessageId||!validInstant(message.time)||Date.parse(message.time)<Date.parse(draft.updatedAt)||!/^(?:\u786e\u8ba4(?:\u4fdd\u5b58(?:\u4eca\u65e5)?(?:\u8ba1\u5212|\u603b\u7ed3|\u590d\u76d8)?)?|\u4fdd\u5b58(?:\u4eca\u65e5)?(?:\u8ba1\u5212|\u603b\u7ed3|\u590d\u76d8)?|confirm(?: and save)?|yes,? save)[\u3002.!\uff01\s]*$/i.test(text)||/\u8ba1\u5212/.test(text)&&draft.type!=='plan'||/\u603b\u7ed3|\u590d\u76d8/.test(text)&&draft.type!=='summary')throw fail('Reply "Confirm and save" in Daily, or use the draft\'s confirmation button.',409);confirmation={method:'chat',messageId:message.id};}
   else{if(input.confirmed!==true)throw fail('Confirm the draft first.');if(this.daily.active)throw fail('Daily is still working. Wait until this turn finishes before reviewing.',409);confirmation={method:'button'};}
   const at=this.now().toISOString(),entry={id:randomUUID(),draftId:draft.id,draftRevision:draft.revision,date:draft.date,type:draft.type,timeZone:draft.timeZone,content:structuredClone(draft.content),createdAt:draft.createdAt,confirmedAt:at,confirmation};data.entries.push(entry);draft.status='saved';draft.updatedAt=at;return{value:entry};
  });
 }
 async discard(input){return this.change(input.expectedRevision,data=>{const draft=data.drafts.find(d=>d.id===input.id);if(!draft||draft.revision!==input.expectedDraftRevision||draft.status!=='pending')throw fail('The draft changed. Refresh the page.',409);draft.status='discarded';draft.updatedAt=this.now().toISOString();draft.revision++;return{value:draft};});}
}
export async function handleTrackRequest(req,res,{service,daily,origin,json}){
 const path=new URL(req.url,origin).pathname;if(path!=='/api/track'&&!path.startsWith('/api/track/'))return false;
 if(path==='/api/track'&&req.method==='GET'){json(res,200,await service.view());return true;}
 const action=path.slice('/api/track/'.length);if(!['start','propose','confirm','discard'].includes(action)){json(res,404,{error:'Not found'});return true;}
 if(req.method!=='POST'){json(res,405,{error:'Method not allowed'});return true;}
 if(req.headers.origin!==origin||req.headers['x-ruwithme-csrf']!==daily.csrf){json(res,403,{error:'Refresh before changing Track.'});return true;}
 if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json'){json(res,415,{error:'JSON required'});return true;}
 const chunks=[];let size=0;for await(const chunk of req.iterator({destroyOnReturn:false})){size+=chunk.length;if(size>128000){req.resume();json(res,413,{error:'Request too large'});return true;}chunks.push(chunk);}
 const input=JSON.parse(Buffer.concat(chunks,size).toString('utf8'));if(!input||typeof input!=='object'||Array.isArray(input))throw fail('A JSON object is required.');json(res,200,await service[action](input,origin));return true;
}
