import {resolve} from 'node:path';
import {realpath} from 'node:fs/promises';
import {readCalendar} from './records.mjs';
import {projectGoogleSnapshot,commitCalendar,syncWindow,readPrivateJSON,writePrivateJSON,ensureCalendarFolder} from './google-calendar.mjs';

const error=(message,status=502)=>Object.assign(new Error(message),{status});
// Connector payloads are data, not instructions. Never persist raw responses.
export function connectorData(result){
 if(!result||result.isError){
  let reason=result?.structuredContent?.error?.message||result?.structuredContent?.error;
  if(typeof reason!=='string')for(const block of result?.content||[])if(block.type==='text'){try{const parsed=JSON.parse(block.text);reason=parsed.error?.message||parsed.error||parsed.message;}catch{reason=block.text;}if(typeof reason==='string'&&/approval|denied|review|policy|permission|\u62d2\u7edd|\u6743\u9650/i.test(reason))break;}
  throw error('The Google Calendar operation in Codex failed. Check the connection and permissions.'+(typeof reason==='string'&&/approval|denied|review|policy|permission|\u62d2\u7edd|\u6743\u9650/i.test(reason)?' '+reason.slice(0,800):''));
 }
 if(result.structuredContent&&typeof result.structuredContent==='object')return result.structuredContent;
 for(const block of result.content||[])if(block.type==='text'){try{const value=JSON.parse(block.text);if(value&&typeof value==='object')return value;}catch{}}
 throw error('Google Calendar returned unrecognized data. The previous snapshot is preserved.');
}
function normalizeEvent(row,timeZone){
 if(!row||typeof row.id!=='string'||!row.id)throw error('Google Calendar returned an event without an ID.');
 const result={id:row.id,summary:row.summary,status:row.status,location:row.location,htmlLink:row.url||row.htmlLink,recurringEventId:row.recurring_event_id||row.recurringEventId};
 const normalize=value=>typeof value==='string'?(/^\d{4}-\d{2}-\d{2}$/.test(value)?{date:value}:{dateTime:value,timeZone}):value;
 // The connector can encode date-only boundaries as offset-free midnight
 // strings. Keep those dates, never invent a UTC offset for floating times.
 const midnight=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.0+)?$/.test(value);
 if(midnight(row.start)&&midnight(row.end)&&row.end.slice(0,10)>row.start.slice(0,10)){
  result.start={date:row.start.slice(0,10)};result.end={date:row.end.slice(0,10)};result.sourceDateEncoding='connector-midnight';
 }else{result.start=normalize(row.start);result.end=normalize(row.end);}
 const original=row.original_start_time||row.originalStartTime;if(original)result.originalStartTime=normalize(original);
 return result;
}
export class CodexCalendarService{
 constructor({daily,workspace,privateRoot,now=()=>new Date()}){this.daily=daily;this.workspace=workspace;this.privateRoot=privateRoot;this.now=now;this.busy=false;this.lastError='';this.metadata=null;this.metadataAt=0;this.metadataPromise=null;}
 async exclusive(run){if(this.busy)throw error('Calendar is syncing. Please wait.',409);this.busy=true;try{return await run();}finally{this.busy=false;}}
 async preferences(){
  try{if(await realpath(this.privateRoot)!==resolve(this.privateRoot))throw error('Calendar preferences cannot use symbolic links.',403);}catch(e){if(e.code==='ENOENT')return null;throw e;}
  const data=await readPrivateJSON(resolve(this.privateRoot,'preferences.json'));
  if(data&&(data.version!==1||typeof data.account!=='string'||!Array.isArray(data.selectedCalendarIds)||data.selectedCalendarIds.some(id=>typeof id!=='string')))throw error('Calendar sync preferences need review. The original file is preserved.',422);
  return data;
 }
 async call(name,args={}){return connectorData(await this.daily.calendarTool(name,args));}
 async discover(force=false){
  if(!force&&this.metadata&&Date.now()-this.metadataAt<30000)return this.metadata;
  if(this.metadataPromise)return this.metadataPromise;
  this.metadataPromise=(async()=>{
   const caps=await this.daily.calendarCapabilities();
   if(!caps.connected)throw error('Connect Google Calendar and allow reads in Codex, then click Retry here.',428);
   const profile=await this.call('get_profile');
   if(typeof profile.email!=='string'||!profile.email||typeof profile.id!=='string')throw error('Google Calendar did not return a valid account identity.');
   const calendar=await readCalendar(this.workspace),calendars=[],ids=new Set(),tokens=new Set();let cursor;
   do{
    const key=cursor||'';if(tokens.has(key)||tokens.size>=100)throw error('Calendar-list pagination did not finish. Previous data is preserved.');tokens.add(key);
    const page=await this.call('list_calendars',{max_results:250,...(cursor?{next_page_token:cursor}:{})});
    if(!Array.isArray(page.calendars))throw error('Google Calendar returned an incomplete calendar list.');
    for(const row of page.calendars){
     if(typeof row.id!=='string'||ids.has(row.id))throw error('Google Calendar returned duplicate or invalid calendar IDs.');ids.add(row.id);
     if(!['owner','writer','reader'].includes(row.access_role))continue;
     calendars.push({id:row.id,title:String(row.summary||row.id).slice(0,500),timeZone:row.time_zone||row.timeZone||calendar.timeZone,primary:row.primary===true,writable:['owner','writer'].includes(row.access_role)});
    }
    cursor=page.next_page_token;if(cursor!==undefined&&cursor!==null&&typeof cursor!=='string')throw error('Google Calendar returned an invalid page token.');
   }while(cursor);
   if(!calendars.length)throw error('This Google account has no readable calendars.',403);
   const prefs=await this.preferences(),selected=prefs?.account===profile.email?prefs.selectedCalendarIds.filter(id=>calendars.some(c=>c.id===id)):calendars.filter(c=>c.primary).map(c=>c.id);
   const metadata={account:profile.email,identity:profile.id,calendars,selectedCalendarIds:selected.length?selected:[calendars[0].id],canWrite:caps.canWrite,canCreate:!!caps.canCreate};
   this.metadata=metadata;this.metadataAt=Date.now();return metadata;
  })().catch(e=>{this.metadata=null;this.metadataAt=0;throw e;}).finally(()=>{this.metadataPromise=null;});return this.metadataPromise;
 }
 async status(){
  try{const data=await this.discover();return{via:'codex',configured:true,connected:true,needsReconnect:false,account:data.account,calendars:data.calendars,selectedCalendarIds:data.selectedCalendarIds,canWrite:data.canWrite,canCreate:data.canCreate,readOnly:true,busy:this.busy,error:this.lastError,window:syncWindow(this.now())};}
  catch(e){return{via:'codex',configured:true,connected:false,needsReconnect:false,account:null,calendars:[],selectedCalendarIds:[],canWrite:false,readOnly:true,busy:this.busy,error:e.message,window:syncWindow(this.now())};}
 }
 async calendars(){this.metadataAt=0;await this.discover(true);return this.status();}
 async sync({calendarIds,expectedRevision}={}){return this.exclusive(async()=>{
  try{
   if(!Array.isArray(calendarIds)||!calendarIds.length||calendarIds.length>10||new Set(calendarIds).size!==calendarIds.length||calendarIds.some(id=>typeof id!=='string')||!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw error('Select 1–10 calendars and use the current Calendar revision.',400);
   const before=await readCalendar(this.workspace);if(before.revision!==expectedRevision)throw error('Calendar changed. Refresh before syncing.',409);
   const data=await this.discover(true),calendars=calendarIds.map(id=>data.calendars.find(c=>c.id===id));
   if(calendars.some(c=>!c))throw error('A selected calendar is unavailable on this connection. Refresh the calendar list.',409);
   const window=syncWindow(this.now()),itemsByCalendar=new Map();let total=0;
   for(const cal of calendars){const rows=[],tokens=new Set();let cursor;
    do{
     const key=cursor||'';if(tokens.has(key)||tokens.size>=100)throw error('Google Calendar event pagination did not finish. Previous events are preserved.');tokens.add(key);
     const page=await this.call('search_events',{calendar_id:cal.id,time_min:window.startAt,time_max:window.endAt,timezone_str:before.timeZone,max_results:250,...(cursor?{next_page_token:cursor}:{})});
     if(!Array.isArray(page.events))throw error('Google Calendar returned an incomplete event list.');
     total+=page.events.length;if(total>9000)throw error('The event count exceeds local snapshot capacity. Select fewer calendars.',413);
     rows.push(...page.events.map(row=>normalizeEvent(row,cal.timeZone)));
     cursor=page.next_page_token;if(cursor!==undefined&&cursor!==null&&typeof cursor!=='string')throw error('Google Calendar returned an invalid page token.');
    }while(cursor);
    itemsByCalendar.set(cal.id,rows);
   }
   const check=await this.call('get_profile');if(check.id!==data.identity||check.email!==data.account)throw error('The Google account changed during sync. Previous events are preserved; try again.',409);
   const syncedAt=this.now().toISOString();
   const next=await commitCalendar(this.workspace,expectedRevision,current=>projectGoogleSnapshot(current,{account:data.account,calendars,itemsByCalendar,window,syncedAt}));
   await ensureCalendarFolder(this.privateRoot,true);await writePrivateJSON(resolve(this.privateRoot,'preferences.json'),{version:1,account:data.account,selectedCalendarIds:calendarIds});
   data.selectedCalendarIds=calendarIds;this.lastError='';
   return{via:'codex',revision:next.revision,syncedAt,eventCount:calendars.reduce((n,c)=>n+(itemsByCalendar.get(c.id)||[]).filter(e=>e.status!=='cancelled').length,0),window};
  }catch(e){this.lastError=e.message;throw e;}
 });}
 async configure(){throw error('Calendar uses your authorized Codex connection. Google OAuth JSON is not needed.',409);}
 async authorize(){throw error('Manage the Google Calendar connection in Codex, then refresh Calendar.',409);}
 async disconnect(){throw error('Manage authorization in Codex. Disconnect Google Calendar there; the local cache is preserved.',409);}
 async callback(){throw error('This app connects Calendar through Codex and does not use a separate OAuth callback.',400);}
}
