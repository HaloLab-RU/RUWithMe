import {mkdir,open,rename,unlink,realpath,lstat,chmod} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve} from 'node:path';
import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {execFile} from 'node:child_process';
import {readCalendar,validateCalendar} from './records.mjs';

export const GOOGLE_SCOPES=['https://www.googleapis.com/auth/calendar.calendarlist.readonly','https://www.googleapis.com/auth/calendar.events.readonly'];
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const hash=text=>createHash('sha256').update(text).digest('hex').slice(0,36);
const validZone=value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return typeof value==='string';}catch{return false;}};
const sourceId=(account,id)=>'google-'+hash(JSON.stringify([account,id]));
const iso=value=>new Date(value).toISOString();
export function syncWindow(now=new Date()){
 const day=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate());
 return{startAt:iso(day-30*864e5),endAt:iso(day+181*864e5)};
}
async function folder(path,privateFolder=false){
 await mkdir(path,{recursive:true,mode:0o700});
 if(await realpath(path)!==resolve(path))throw fail('Calendar storage cannot use symbolic links.',403);
 if(privateFolder)await chmod(path,0o700);
}
async function safeJSON(path){
 let handle;try{handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);const info=await handle.stat();if(!info.isFile()||info.size>4*1024*1024)throw fail('Calendar connection storage needs review.',422);return JSON.parse(await handle.readFile('utf8'));}
 catch(e){if(e.code==='ENOENT')return null;if(e.code==='ELOOP')throw fail('Calendar storage cannot use symbolic links.',403);if(e instanceof SyntaxError)throw fail('Calendar connection storage needs review. Existing files were kept.',422);throw e;}finally{await handle?.close();}
}
async function atomicJSON(path,data){
 try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())throw fail('Calendar storage must be a regular file.',403);}catch(e){if(e.code!=='ENOENT')throw e;}
 const body=JSON.stringify(data,null,2)+'\n';if(Buffer.byteLength(body)>4*1024*1024)throw fail('Calendar snapshot exceeds the 4 MiB limit. Previous data was kept.',413);
 const temp=path+'.'+randomUUID()+'.tmp';let handle;
 try{handle=await open(temp,'wx',0o600);await handle.writeFile(body);await handle.sync();await handle.close();handle=null;await rename(temp,path);}finally{await handle?.close();await unlink(temp).catch(()=>{});}
}
export {safeJSON as readPrivateJSON,atomicJSON as writePrivateJSON,folder as ensureCalendarFolder};

// A complete, bounded snapshot replaces only the selected source's projection.
// Missing events are removed from this cache, never fabricated as cancellations.
export function projectGoogleSnapshot(calendar,{account,calendars,itemsByCalendar,window,syncedAt}){
 validateCalendar(calendar);const next=structuredClone(calendar);
 for(const cal of calendars){
  const sid=sourceId(account,cal.id),previous=new Map(next.events.filter(e=>e.sourceId===sid).map(e=>[e.sourceEventId,e]));
  next.events=next.events.filter(e=>e.sourceId!==sid);
  next.sources=next.sources.filter(s=>s.id!==sid);
  next.sources.push({id:sid,provider:'google',account,calendarId:cal.id,title:cal.title,timeZone:cal.timeZone,lastSyncedAt:syncedAt,window});
  for(const raw of itemsByCalendar.get(cal.id)||[]){
   if(typeof raw.id!=='string'||!raw.id)throw fail('Google returned an event without an identity. Previous snapshot was kept.',502);
   const old=previous.get(raw.id);
   if(raw.status==='cancelled'){
    // Google tombstones may contain only an ID. Retain known occurrence dates.
    if(old)next.events.push({...old,status:'cancelled'});
    continue;
   }
   const zone=raw.start?.timeZone||cal.timeZone;
   if(!validZone(zone))throw fail('Google returned an unsupported time zone.',502);
   const allDay=typeof raw.start?.date==='string';
   const event={id:'g-'+hash(JSON.stringify([sid,raw.id])),sourceId:sid,sourceEventId:raw.id,title:(raw.summary?.trim()||'(Untitled event)').slice(0,1000),status:raw.status==='tentative'?'tentative':'confirmed',allDay,timeZone:zone};
   if(old?.displayTitle?.language==='en'&&old.displayTitle.sourceTitle===event.title)event.displayTitle=structuredClone(old.displayTitle);
   if(allDay){event.startDate=raw.start.date;event.endDate=raw.end?.date;if(raw.sourceDateEncoding==='connector-midnight')event.sourceDateEncoding=raw.sourceDateEncoding;}
   else{event.startAt=raw.start?.dateTime;event.endAt=raw.end?.dateTime;}
   if(typeof raw.location==='string')event.location=raw.location.slice(0,2000);
   if(typeof raw.recurringEventId==='string')event.recurringEventId=raw.recurringEventId;
   if(raw.originalStartTime?.date)event.originalStartDate=raw.originalStartTime.date;
   else if(raw.originalStartTime?.dateTime)event.originalStartAt=raw.originalStartTime.dateTime;
   if(typeof raw.htmlLink==='string'){try{const url=new URL(raw.htmlLink);if(url.protocol==='https:'&&['calendar.google.com','www.google.com'].includes(url.hostname)&&!url.username&&!url.password)event.sourceUrl=url.href;}catch{}}
   next.events.push(event);
  }
 }
 next.revision++;return validateCalendar(next);
}

export async function commitCalendar(root,expectedRevision,transform){
 const base=await realpath(root),dir=resolve(base,'records');await folder(dir);
 const lock=resolve(dir,'.calendar.lock');let handle;
 try{
  try{handle=await open(lock,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw fail('Calendar is being updated. Try Sync again shortly.',409);throw e;}
  const current=await readCalendar(base);
  if(current.revision!==expectedRevision)throw fail('Calendar changed during sync. Refresh and try again; existing records were kept.',409);
  const next=transform(structuredClone(current));validateCalendar(next);
  if(next.revision!==current.revision+1)throw fail('Calendar revision must increase exactly once.',422);
  await atomicJSON(resolve(dir,'calendar.json'),next);return next;
 }finally{if(handle){await handle.close();await unlink(lock).catch(()=>{});}}
}

export class GoogleCalendarService{
 constructor({workspace,privateRoot,origin,fetchImpl=fetch,now=()=>new Date(),openBrowser}={}){
  this.workspace=workspace;this.privateRoot=privateRoot;this.origin=origin;this.fetch=fetchImpl;this.now=now;
  this.openBrowser=openBrowser||((url)=>new Promise((yes,no)=>execFile(process.platform==='darwin'?'open':process.platform==='win32'?'rundll32':'xdg-open',process.platform==='win32'?['url.dll,FileProtocolHandler',url]:[url],e=>e?no(e):yes())));
  this.pending=null;this.busy=false;this.lastError='';this.reauth=false;
 }
 get stateFile(){return resolve(this.privateRoot,'connection.json');}
 async state(){
  // Missing storage is an unconfigured connection, not an invitation to import.
  try{if(await realpath(this.privateRoot)!==resolve(this.privateRoot))throw fail('Calendar connection cannot use symbolic links.',403);}catch(e){if(e.code==='ENOENT')return{version:1};throw e;}
  const data=await safeJSON(this.stateFile);if(data&&data.version!==1)throw fail('Unsupported Google connection version.',422);
  if(data){
   const invalid=()=>fail('Google connection storage needs review. Existing data was kept.',422);
   if(data.client&&(typeof data.client.clientId!=='string'||typeof data.client.clientSecret!=='string'))throw invalid();
   if(data.tokens&&(!data.client||typeof data.tokens.accessToken!=='string'||!data.tokens.accessToken||typeof data.tokens.refreshToken!=='string'||!data.tokens.refreshToken||!Number.isFinite(data.tokens.expiresAt)||typeof data.account!=='string'||!data.account||!Array.isArray(data.calendars)||!Array.isArray(data.selectedCalendarIds)))throw invalid();
   if(data.calendars&&(!Array.isArray(data.calendars)||data.calendars.length>25000||data.calendars.some(c=>!c||typeof c.id!=='string'||typeof c.title!=='string'||!validZone(c.timeZone))))throw invalid();
   if(data.selectedCalendarIds&&(!Array.isArray(data.selectedCalendarIds)||data.selectedCalendarIds.some(id=>typeof id!=='string')))throw invalid();
  }
  return data||{version:1};
 }
 async save(data){await folder(this.privateRoot,true);await atomicJSON(this.stateFile,data);}
 async exclusive(run){if(this.busy)throw fail('Google Calendar is busy. Please wait for the current operation.',409);this.busy=true;try{return await run();}finally{this.busy=false;}}
 async status(){const data=await this.state();return{configured:!!data.client,connected:!!data.tokens,needsReconnect:this.reauth,account:data.account||null,calendars:(data.calendars||[]).map(c=>({id:c.id,title:c.title,timeZone:c.timeZone,primary:c.primary===true})),selectedCalendarIds:data.selectedCalendarIds||[],busy:this.busy,error:this.lastError,readOnly:true,window:syncWindow(this.now())};}
 async configure(input){return this.exclusive(async()=>{
  const client=input?.credentials?.installed;
  if(!client||typeof client.client_id!=='string'||!client.client_id.endsWith('.apps.googleusercontent.com')||client.client_id.length>500||typeof client.client_secret!=='string'||!client.client_secret||client.client_secret.length>500)throw fail('Choose the OAuth JSON downloaded for a Google Desktop app. Web and service-account credentials are not supported.');
  const current=await this.state();if(current.tokens)throw fail('Disconnect the existing Google connection before replacing its app configuration.',409);
  await this.save({version:1,client:{clientId:client.client_id,clientSecret:client.client_secret}});this.pending=null;this.lastError='';return this.status();
 });}
 async authorize(){return this.exclusive(async()=>{
  const data=await this.state();if(!data.client)throw fail('Set up a Google Desktop OAuth client first.',428);
  const verifier=randomBytes(48).toString('base64url'),state=randomBytes(32).toString('base64url'),redirect=this.origin+'/api/calendar/google/callback';
  this.pending={verifier,state,redirect,expires:Date.now()+600000};
  const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search=new URLSearchParams({client_id:data.client.clientId,redirect_uri:redirect,response_type:'code',scope:GOOGLE_SCOPES.join(' '),access_type:'offline',prompt:'consent select_account',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
  let opened=true;try{await this.openBrowser(url.href);}catch{opened=false;}
  this.lastError='';return{authorizationUrl:url.href,opened};
 });}
 async responseJSON(response){
  if(Number(response.headers.get('content-length'))>8*1024*1024)throw fail('Google response exceeded the supported size.',502);
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>8*1024*1024)throw fail('Google response exceeded the supported size.',502);chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks,size).toString('utf8'));}catch{throw fail('Google returned an unreadable response.',502);}
 }
 async request(url,options={}){
  let response;try{response=await this.fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw fail('Could not reach Google. Previous calendar data was kept.',502);}
  if(!response.ok){await response.body?.cancel().catch(()=>{});if(response.status===401||response.status===400&&options.method==='POST'){this.reauth=true;throw fail('Google authorization expired or was declined. Reconnect your account.',401);}if(response.status===403)throw fail('Google denied access. Check Calendar API, read-only permissions and your account policies.',403);throw fail(response.status===429?'Google rate limit reached. Try Sync later.':'Google could not complete the request. Previous calendar data was kept.',502);}
  return this.responseJSON(response);
 }
 async tokenRequest(data,params){return this.request('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:data.client.clientId,client_secret:data.client.clientSecret,...params}).toString()});}
 async access(data){
  if(!data.tokens)throw fail('Connect your Google account first.',428);
  if(data.tokens.expiresAt>Date.now()+60000)return data.tokens.accessToken;
  if(!data.tokens.refreshToken){this.reauth=true;throw fail('Reconnect Google to renew calendar access.',401);}
  const token=await this.tokenRequest(data,{grant_type:'refresh_token',refresh_token:data.tokens.refreshToken});
  if(typeof token.access_token!=='string')throw fail('Google did not return a valid access token.',502);
  data.tokens={accessToken:token.access_token,refreshToken:token.refresh_token||data.tokens.refreshToken,expiresAt:Date.now()+Number(token.expires_in||3600)*1000};await this.save(data);return data.tokens.accessToken;
 }
 async api(path,token,params){const url=new URL('https://www.googleapis.com/calendar/v3/'+path);url.search=new URLSearchParams(params).toString();return this.request(url.href,{headers:{Authorization:'Bearer '+token}});}
 async listCalendars(token){
  const rows=[],seen=new Set();let pageToken='';
  do{if(seen.has(pageToken)||seen.size>=100)throw fail('Google calendar pagination was incomplete.',502);seen.add(pageToken);
   const page=await this.api('users/me/calendarList',token,{maxResults:'250',fields:'nextPageToken,items(id,summary,timeZone,primary,accessRole,deleted)',...(pageToken?{pageToken}:{})});
   if(!Array.isArray(page.items))throw fail('Google returned an incomplete calendar list.',502);
   for(const row of page.items)if(!row.deleted&&typeof row.id==='string'&&['reader','writer','owner'].includes(row.accessRole)){
    if(!validZone(row.timeZone))throw fail('Google returned an unsupported calendar time zone.',502);
    rows.push({id:row.id,title:String(row.summary||row.id).slice(0,500),timeZone:row.timeZone,primary:row.primary===true});
   }
   pageToken=page.nextPageToken||'';
  }while(pageToken);
  if(!rows.some(row=>row.primary))throw fail('Google did not identify your primary calendar. Check permissions and reconnect.',403);
  return rows;
 }
 async callback(query){
  const pending=this.pending,received=query.get('state')||'';
  if(!pending||Date.now()>pending.expires||Buffer.byteLength(received)!==Buffer.byteLength(pending.state)||!timingSafeEqual(Buffer.from(received),Buffer.from(pending.state)))throw fail('Google connection expired or has an invalid state. Click Connect again.',400);
  return this.exclusive(async()=>{this.pending=null;
   try{
    if(query.has('error')||!query.get('code'))throw fail('Google authorization was not completed. You can connect again.',400);
    const current=await this.state(),token=await this.tokenRequest(current,{grant_type:'authorization_code',code:query.get('code'),code_verifier:pending.verifier,redirect_uri:pending.redirect});
    const granted=new Set(String(token.scope||'').split(' '));if(!GOOGLE_SCOPES.every(scope=>granted.has(scope)))throw fail('Both calendar-list and event read permissions are needed. Reconnect and allow both.',403);
    if(typeof token.access_token!=='string')throw fail('Google did not return a valid access token.',502);
    const calendars=await this.listCalendars(token.access_token),account=calendars.find(c=>c.primary).id;
    if(current.account&&account!==current.account)throw fail('A different Google account was chosen. Disconnect first to switch accounts.',409);
    const refreshToken=token.refresh_token||current.tokens?.refreshToken;if(!refreshToken)throw fail('Google did not grant offline access. Reconnect to authorize ongoing sync.',403);
    await this.save({...current,account,calendars,selectedCalendarIds:current.selectedCalendarIds||[account],tokens:{accessToken:token.access_token,refreshToken,expiresAt:Date.now()+Number(token.expires_in||3600)*1000}});
    this.reauth=false;this.lastError='';
   }catch(e){this.lastError=e.message;throw e;}
  });
 }
 async calendars(){return this.exclusive(async()=>{
  const data=await this.state(),token=await this.access(data),calendars=await this.listCalendars(token);
  if(calendars.find(c=>c.primary).id!==data.account)throw fail('Google account changed. Reconnect before syncing.',409);
  data.calendars=calendars;await this.save(data);return this.status();
 });}
 async sync({calendarIds,expectedRevision}={}){return this.exclusive(async()=>{
  try{
   if(!Array.isArray(calendarIds)||!calendarIds.length||calendarIds.length>10||new Set(calendarIds).size!==calendarIds.length||calendarIds.some(id=>typeof id!=='string')||!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw fail('Choose 1–10 calendars and supply the current calendar revision.');
   const data=await this.state(),token=await this.access(data),available=await this.listCalendars(token);
   if(available.find(c=>c.primary).id!==data.account)throw fail('Google account changed. Reconnect before syncing.',409);
   const calendars=calendarIds.map(id=>available.find(c=>c.id===id));if(calendars.some(c=>!c))throw fail('A selected calendar is no longer readable. Refresh your calendar list.',409);
   const window=syncWindow(this.now()),itemsByCalendar=new Map();let total=0;
   for(const cal of calendars){const items=[],seen=new Set();let pageToken='';
    do{if(seen.has(pageToken)||seen.size>=100)throw fail('Google event pagination was incomplete. Previous data was kept.',502);seen.add(pageToken);
     const page=await this.api('calendars/'+encodeURIComponent(cal.id)+'/events',token,{timeMin:window.startAt,timeMax:window.endAt,singleEvents:'true',showDeleted:'true',maxResults:'2500',fields:'nextPageToken,items(id,summary,status,start,end,location,recurringEventId,originalStartTime,htmlLink)',...(pageToken?{pageToken}:{})});
     if(page.items!==undefined&&!Array.isArray(page.items))throw fail('Google returned an incomplete event page. Previous data was kept.',502);
     items.push(...(page.items||[]));total+=(page.items||[]).length;if(total>9000)throw fail('Too many events for this local snapshot. Select fewer calendars.',413);pageToken=page.nextPageToken||'';
    }while(pageToken);
    itemsByCalendar.set(cal.id,items);
   }
   // All pages and all calendars must succeed before changing user records.
   const syncedAt=this.now().toISOString();
   const next=await commitCalendar(this.workspace,expectedRevision,current=>projectGoogleSnapshot(current,{account:data.account,calendars,itemsByCalendar,window,syncedAt}));
   data.selectedCalendarIds=calendarIds;data.calendars=available;await this.save(data);this.lastError='';this.reauth=false;
   return{revision:next.revision,syncedAt,eventCount:next.events.filter(e=>calendarIds.some(id=>e.sourceId===sourceId(data.account,id))&&e.status!=='cancelled').length,window};
  }catch(e){this.lastError=e.message;throw e;}
 });}
 async disconnect(){return this.exclusive(async()=>{
  const data=await this.state();await this.save({version:1,...(data.client?{client:data.client}:{})});this.pending=null;this.reauth=false;this.lastError='';
  return{disconnected:true,cacheKept:true};
 });}
}

export async function handleGoogleRequest(req,res,{service,daily,origin,json}){
 const url=new URL(req.url,origin);if(!url.pathname.startsWith('/api/calendar/google/'))return false;
 if(!service){json(res,503,{error:'Google Calendar service is unavailable.'});return true;}
 if(url.pathname==='/api/calendar/google/callback'){
  if(req.method!=='GET'){json(res,405,{error:'Method not allowed'});return true;}
  try{await service.callback(url.searchParams);}catch(e){if(e.status===400&&!service.lastError){json(res,400,{error:e.message});return true;}}
  res.writeHead(303,{Location:'/\x23calendar','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end();return true;
 }
 if(url.pathname==='/api/calendar/google/status'){
  if(req.method!=='GET'){json(res,405,{error:'Method not allowed'});return true;}
  json(res,200,await service.status());return true;
 }
 const actions={configure:body=>service.configure(body),authorize:()=>service.authorize(),calendars:()=>service.calendars(),sync:body=>service.sync(body),disconnect:()=>service.disconnect()},key=url.pathname.slice('/api/calendar/google/'.length),action=Object.hasOwn(actions,key)?actions[key]:null;
 if(!action){json(res,404,{error:'Not found'});return true;}
 if(req.method!=='POST'){json(res,405,{error:'Method not allowed'});return true;}
 if(req.headers.origin!==origin||req.headers['x-ruwithme-csrf']!==daily.csrf){json(res,403,{error:'Refresh the page before changing the calendar connection.'});return true;}
 if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json'){json(res,415,{error:'JSON required'});return true;}
 const chunks=[];let size=0;
 for await(const chunk of req.iterator({destroyOnReturn:false})){size+=chunk.length;if(size>16000){req.resume();json(res,413,{error:'Request too large'});return true;}chunks.push(chunk);}
 let body;try{body=JSON.parse(Buffer.concat(chunks,size).toString('utf8'));}catch{throw fail('A valid JSON object is required.');}
 if(!body||typeof body!=='object'||Array.isArray(body))throw fail('A JSON object is required.');
 json(res,200,await action(body));return true;
}
