import {open,realpath,readdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve} from 'node:path';

export const emptyCommitments=()=>({version:1,revision:0,items:[]});
export const emptyCalendar=()=>({version:1,revision:0,timeZone:'America/New_York',sources:[],events:[],workBlocks:[]});
export const emptyTrack=()=>({version:1,revision:0,drafts:[],entries:[]});
export const emptySessions=()=>({version:1,revision:0,items:[]});
export const weekStart=value=>{const d=new Date(value+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));return d.toISOString().slice(0,10);};
export const shiftDate=(value,days)=>{const d=new Date(value+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);};
const invalid=message=>Object.assign(new Error('Records need review: '+message+'. Existing files were not changed.'),{status:422});
const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T12:00:00Z'))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;
const instant=value=>typeof value==='string'&&date(value.slice(0,10))&&/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)&&!Number.isNaN(Date.parse(value));
export {date as validDate,instant as validInstant};
function zone(value){try{if(typeof value!=='string')return false;new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}}
function owner(path){return path===null||path===undefined||typeof path==='string'&&/^(research|courses|learn|career|admin|personal)\//.test(path)&&!path.includes('\\')&&!path.split('/').some(p=>!p||p==='..'||p==='.'||p.startsWith('.'));}
function list(rows,label){if(!Array.isArray(rows)||rows.length>10000)throw invalid('invalid '+label);const ids=new Set();for(const row of rows){if(!row||typeof row.id!=='string'||!row.id||row.id.length>120||ids.has(row.id))throw invalid('missing or duplicate '+label+' ID');ids.add(row.id);}return ids;}
function header(data,label){if(!data||data.version!==1||!Number.isSafeInteger(data.revision)||data.revision<0)throw invalid('unsupported '+label+' version/revision');}
function title(row,label){if(typeof row.title!=='string'||!row.title.trim()||row.title.length>1000)throw invalid('invalid '+label+' title');}
function period(row){
 if(!zone(row.timeZone))throw invalid('a calendar item needs a valid time zone');
 if(row.allDay===true){if(!date(row.startDate)||!date(row.endDate)||row.endDate<=row.startDate||row.startAt!==undefined||row.endAt!==undefined)throw invalid('all-day events use dates and an exclusive endDate');}
 else if(row.allDay!==false||!instant(row.startAt)||!instant(row.endAt)||Date.parse(row.endAt)<=Date.parse(row.startAt)||row.startDate!==undefined||row.endDate!==undefined)throw invalid('timed items need explicit-offset instants and a later end');
}
export function trackContent(type,content){
 if(!content||typeof content!=='object'||Array.isArray(content))throw invalid('invalid Track content');
 const fields=type==='plan'?['priorities','schedule']:type==='summary'?['completed','unfinished','blockers']:type==='weekly'?['progress','unfinished','blockers','nextWeek']:null;
 if(!fields)throw invalid('invalid Track type');
 const result={};for(const key of fields){const rows=content[key];if(!Array.isArray(rows)||rows.length>60||rows.some(s=>typeof s!=='string'||!s.trim()||s.length>2000))throw invalid('invalid Track '+key);result[key]=rows.map(s=>s.trim());}
 const key=type==='plan'?'notes':'oneLine',value=content[key]??'';if(typeof value!=='string'||value.length>(type==='plan'?4000:500)||type!=='plan'&&(!value.trim()||/[\r\n]/.test(value)))throw invalid('invalid Track '+key);result[key]=value.trim();return result;
}
export function validateTrack(data){
 header(data,'Track');const drafts=list(data.drafts,'Track draft');list(data.entries,'Track entry');
 for(const row of [...data.drafts,...data.entries]){if(!date(row.date)||!zone(row.timeZone)||!instant(row.createdAt))throw invalid('invalid Track date, time zone or creation time');trackContent(row.type,row.content);if(row.type==='weekly'&&weekStart(row.date)!==row.date)throw invalid('weekly reviews must use a Monday start date');}
 for(const draft of data.drafts){if(!Number.isSafeInteger(draft.revision)||draft.revision<1||!['pending','saved','discarded'].includes(draft.status)||!instant(draft.updatedAt))throw invalid('invalid Track draft revision/state');}
 const accepted=new Set();for(const entry of data.entries){if(!drafts.has(entry.draftId)||!Number.isSafeInteger(entry.draftRevision)||entry.draftRevision<1||!instant(entry.confirmedAt)||!['button','chat'].includes(entry.confirmation?.method)||entry.confirmation.method==='chat'&&typeof entry.confirmation.messageId!=='string'||accepted.has(entry.draftId))throw invalid('invalid or duplicate Track confirmation');accepted.add(entry.draftId);}
 for(const draft of data.drafts)if((draft.status==='saved')!==accepted.has(draft.id))throw invalid('Track draft/confirmation mismatch');
 return data;
}
export function validateSessions(data){
 header(data,'sessions');list(data.items,'session');
 const check=row=>{if(!date(row.date)||!zone(row.timeZone)||!owner(row.ownerPath)||!instant(row.createdAt)||!instant(row.updatedAt)||!Number.isSafeInteger(row.revision)||row.revision<1)throw invalid('invalid session date, owner, timestamps or revision');
  for(const key of ['workedOn','outcome','blockers','nextStep'])if(typeof row[key]!=='string'||row[key].length>6000||key==='workedOn'&&!row[key].trim())throw invalid('invalid session '+key);
  if(!Array.isArray(row.files)||row.files.length>20||new Set(row.files).size!==row.files.length||row.files.some(p=>typeof p!=='string'||p.length>1000||! /^(research|courses|learn|career|admin|personal|inbox)\//.test(p)||p.includes('\\')||p.split('/').some(c=>!c||c.startsWith('.'))))throw invalid('invalid session file references');
 };
 for(const row of data.items){check(row);if(!Array.isArray(row.versions)||row.versions.length!==row.revision-1)throw invalid('invalid session revision history');for(const [i,old] of row.versions.entries()){check(old);if(old.revision!==i+1||old.id!==row.id||old.createdAt!==row.createdAt||old.versions!==undefined)throw invalid('invalid previous session version');}}
 return data;
}
export function validateCommitments(data){
 header(data,'commitments');const ids=list(data.items,'commitment'),trash=data.trash??[];list(trash,'deleted commitment');
 for(const row of trash)if(ids.has(row.id)||!instant(row.deletedAt))throw invalid('invalid deleted record or duplicate live/deleted identity');
 for(const row of [...data.items,...trash]){title(row,'commitment');if(!['research','courses','learn','career','admin','personal','other'].includes(row.category)||!['open','in-progress','waiting','done','cancelled'].includes(row.status)||!owner(row.ownerPath))throw invalid('invalid commitment category, state or owner');
  for(const field of ['dueDate','followUpDate'])if(row[field]!==null&&row[field]!==undefined&&!date(row[field]))throw invalid('invalid '+field);
  if(row.dueAt!==null&&row.dueAt!==undefined&&(!instant(row.dueAt)||!zone(row.timeZone)))throw invalid('an exact deadline needs an instant and time zone');
  if(row.dueAt&&row.dueDate)throw invalid('choose a date-only or an exact deadline, not both');
  if(row.kind==='commitment'){
   if(!Number.isSafeInteger(row.revision)||row.revision<1||!instant(row.createdAt)||!instant(row.updatedAt)||!Array.isArray(row.history)||row.history.some(h=>!h||typeof h.id!=='string'||h.action!=='status-changed'||!['open','in-progress','waiting','done','cancelled'].includes(h.from)||!['open','in-progress','waiting','done','cancelled'].includes(h.to)||!instant(h.at)))throw invalid('invalid commitment revision, timestamps or history');
   if(row.completedAt!==null&&row.completedAt!==undefined&&!instant(row.completedAt))throw invalid('invalid commitment completion time');
   for(const [key,max] of [['person',300],['deliverable',2000],['waitingOn',1000]])if(row[key]!==undefined&&(typeof row[key]!=='string'||row[key].length>max))throw invalid('invalid commitment '+key);
  }
  if(row.kind==='todo'){
   if(row.parentCommitmentId!==undefined&&row.parentCommitmentId!==null&&(typeof row.parentCommitmentId!=='string'||!row.parentCommitmentId))throw invalid('invalid parent Commitment');
   if(row.estimateMinutes!==undefined&&row.estimateMinutes!==null&&(!Number.isInteger(row.estimateMinutes)||row.estimateMinutes<5||row.estimateMinutes>1440))throw invalid('invalid effort estimate');
   if(!Number.isSafeInteger(row.revision)||row.revision<1||!instant(row.createdAt)||!instant(row.updatedAt)||!Array.isArray(row.todayDates)||new Set(row.todayDates).size!==row.todayDates.length||row.todayDates.some(d=>!date(d))||!Array.isArray(row.history)||row.history.some(h=>!h||typeof h.id!=='string'||!['completed','reopened','cancelled'].includes(h.action)||!instant(h.at)||h.workDate!==undefined&&(h.synthetic!==true||!date(h.workDate))))throw invalid('invalid Todo revision, dates or completion history');
   if(row.completedAt!==null&&row.completedAt!==undefined&&!instant(row.completedAt))throw invalid('invalid Todo completion time');
  }
 }return data;
}
export function validateCalendar(data){
 header(data,'calendar');if(!zone(data.timeZone))throw invalid('invalid calendar time zone');const sources=list(data.sources,'source');
 for(const source of data.sources){
  if(!['outlook','google'].includes(source.provider))throw invalid('unsupported calendar source');
  if(source.provider==='google'){
   if(typeof source.account!=='string'||!source.account||typeof source.calendarId!=='string'||!source.calendarId||!zone(source.timeZone)||!instant(source.lastSyncedAt)||!instant(source.window?.startAt)||!instant(source.window?.endAt)||Date.parse(source.window.endAt)<=Date.parse(source.window.startAt))throw invalid('invalid Google calendar source identity, zone or sync coverage');
  }
 }
 list(data.events,'event');
 const sourceIds=new Set();for(const event of data.events){title(event,'event');period(event);if(!['confirmed','tentative','cancelled'].includes(event.status))throw invalid('invalid event state');
  if(event.displayTitle!==undefined){const display=event.displayTitle;if(!display||display.language!=='en'||display.sourceTitle!==event.title||typeof display.text!=='string'||!display.text.trim()||display.text.length>1000)throw invalid('invalid local English event title');}
  if(event.sourceId!==null&&event.sourceId!==undefined){if(!sources.has(event.sourceId)||typeof event.sourceEventId!=='string'||!event.sourceEventId)throw invalid('imported events need a known source and stable event identity');const key=JSON.stringify([event.sourceId,event.sourceEventId]);if(sourceIds.has(key))throw invalid('duplicate imported occurrence');sourceIds.add(key);}
 }
 list(data.workBlocks,'work block');for(const block of data.workBlocks){title(block,'work block');period({...block,allDay:false});if(!['planned','cancelled'].includes(block.status)||!owner(block.ownerPath))throw invalid('invalid planned-work block');
  const g=block.google;if(g&&(!['publishing','verifying','uncertain','published'].includes(g.state)||typeof g.operationId!=='string'||!g.operationId||typeof g.account!=='string'||!g.account||typeof g.calendarId!=='string'||!g.calendarId||typeof g.marker!=='string'||!instant(g.startedAt)||g.state==='published'&&(typeof g.eventId!=='string'||!g.eventId||!instant(g.verifiedAt))))throw invalid('invalid Google publication record');
 }
 return data;
}
async function readJson(path,fallback,validate){
 let handle;try{handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);const info=await handle.stat();if(!info.isFile()||info.size>4*1024*1024)throw invalid('record store exceeds the supported size');return validate(JSON.parse(await handle.readFile('utf8')));}
 catch(e){if(e.code==='ENOENT')return fallback();if(e.code==='ELOOP')throw invalid('record files cannot be symbolic links');if(e instanceof SyntaxError)throw invalid('invalid JSON');throw e;}finally{await handle?.close();}
}
export async function readCalendar(root){
 const base=await realpath(root),folder=resolve(base,'records');
 try{if(await realpath(folder)!==folder)throw invalid('records must remain inside this workspace');}catch(e){if(e.code==='ENOENT')return emptyCalendar();throw e;}
 return readJson(resolve(folder,'calendar.json'),emptyCalendar,validateCalendar);
}
export async function readCommitments(root){
 const base=await realpath(root),folder=resolve(base,'records');
 try{if(await realpath(folder)!==folder)throw invalid('records must remain inside this workspace');}catch(e){if(e.code==='ENOENT')return emptyCommitments();throw e;}
 return readJson(resolve(folder,'commitments.json'),emptyCommitments,validateCommitments);
}
export async function readTrack(root){
 const base=await realpath(root),folder=resolve(base,'records');
 try{if(await realpath(folder)!==folder)throw invalid('records must remain inside this workspace');}catch(e){if(e.code==='ENOENT')return emptyTrack();throw e;}
 return readJson(resolve(folder,'track.json'),emptyTrack,validateTrack);
}
export async function readSessions(root){
 const base=await realpath(root),folder=resolve(base,'records');
 try{if(await realpath(folder)!==folder)throw invalid('records must remain inside this workspace');}catch(e){if(e.code==='ENOENT')return emptySessions();throw e;}
 return readJson(resolve(folder,'sessions.json'),emptySessions,validateSessions);
}
export async function readRecords(root){
 const base=await realpath(root),folder=resolve(base,'records');
 try{if(await realpath(folder)!==folder)throw invalid('records must remain inside this workspace');}catch(e){if(e.code==='ENOENT')return{commitments:emptyCommitments(),calendar:emptyCalendar(),track:emptyTrack(),sessions:emptySessions(),days:[]};throw e;}
 const commitments=await readJson(resolve(folder,'commitments.json'),emptyCommitments,validateCommitments),calendar=await readJson(resolve(folder,'calendar.json'),emptyCalendar,validateCalendar),days=[];
 const daily=resolve(folder,'days');let entries;try{if(await realpath(daily)!==daily)throw invalid('daily records cannot be a symbolic link');entries=await readdir(daily,{withFileTypes:true});}catch(e){if(e.code!=='ENOENT')throw e;entries=[];}
 for(const entry of entries){if(!entry.isFile()||!entry.name.endsWith('.md'))continue;const day=entry.name.slice(0,-3);if(!date(day))throw invalid('daily filenames must be YYYY-MM-DD.md');let handle;try{handle=await open(resolve(daily,entry.name),constants.O_RDONLY|constants.O_NOFOLLOW);const info=await handle.stat();if(info.size>1024*1024)throw invalid('daily record exceeds 1 MB');days.push({date:day,path:'records/days/'+entry.name,content:await handle.readFile('utf8')});}finally{await handle?.close();}}
 return{commitments,calendar,track:await readTrack(root),sessions:await readSessions(root),days:days.sort((a,b)=>b.date.localeCompare(a.date))};
}
