import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,mkdir,readFile,writeFile,rm,stat,symlink,readdir,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GoogleCalendarService,GOOGLE_SCOPES,commitCalendar,projectGoogleSnapshot} from '../app/google-calendar.mjs';
import {emptyCalendar,emptyCommitments,readCalendar,validateCalendar} from '../app/records.mjs';
import {createRequestHandler} from '../app/server.mjs';

const primary={id:'test@example.invalid',summary:'Personal',timeZone:'America/New_York',primary:true,accessRole:'owner'};
const other={id:'study@example.invalid',summary:'Study',timeZone:'America/New_York',accessRole:'reader'};
const event=(id='one',summary='A meeting')=>({id,summary,status:'confirmed',start:{dateTime:'2026-11-01T01:30:00-04:00',timeZone:'America/New_York'},end:{dateTime:'2026-11-01T01:30:00-05:00'},description:'Private body: do not copy',attendees:[{email:'private@example.invalid'}],htmlLink:'https://calendar.google.com/calendar/event?eid=test'});
test('local English titles preserve Google identity and wording, survive unchanged syncs and expire after a source rename',()=>{
 const source=event('one','\u4eca\u65e5\u590d\u76d8'),options={account:primary.id,calendars:[{id:primary.id,title:'Personal',timeZone:primary.timeZone}],itemsByCalendar:new Map([[primary.id,[source]]]),window:{startAt:'2026-10-01T00:00:00Z',endAt:'2026-12-01T00:00:00Z'},syncedAt:'2026-10-20T18:00:00Z'};
 const first=projectGoogleSnapshot(emptyCalendar(),options),original=structuredClone(first.events[0]);first.events[0].displayTitle={language:'en',sourceTitle:source.summary,text:'Daily review'};validateCalendar(first);
 const refreshed=projectGoogleSnapshot(first,options),row=refreshed.events[0];assert.equal(row.displayTitle.text,'Daily review');assert.equal(row.title,original.title);assert.equal(row.id,original.id);assert.equal(row.sourceEventId,original.sourceEventId);assert.equal(row.startAt,original.startAt);assert.equal(row.endAt,original.endAt);
 const renamed=projectGoogleSnapshot(refreshed,{...options,itemsByCalendar:new Map([[primary.id,[{...source,summary:'Renamed by source'}]]])});assert.equal(renamed.events[0].title,'Renamed by source');assert.equal(renamed.events[0].displayTitle,undefined);
 const invalid=structuredClone(first);invalid.events[0].displayTitle.sourceTitle='Old name';assert.throws(()=>validateCalendar(invalid),/English event title/);
});
const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'ru-google-'))),workspace=join(root,'workspace'),privateRoot=join(root,'.ruwithme/google-calendar');
 for(const name of ['inbox','research','courses','learn','records/days'])await mkdir(join(workspace,name),{recursive:true});
 await writeFile(join(workspace,'records/calendar.json'),JSON.stringify(emptyCalendar()));
 await writeFile(join(workspace,'records/commitments.json'),JSON.stringify(emptyCommitments()));
 await writeFile(join(workspace,'inbox/keep.txt'),'Keep original');
 t.after(()=>rm(root,{recursive:true,force:true}));return{root,workspace,privateRoot};
}
async function connected(t,{events,failList=false,identity=primary}={}){
 const f=await fixture(t),calls=[];let account=identity,mode=failList;
 const service=new GoogleCalendarService({...f,origin:'http://127.0.0.1:4191',now:()=>new Date('2026-10-20T15:00:00Z'),openBrowser:async()=>{},fetchImpl:async(url,options)=>{
  const u=new URL(url);calls.push({url:u,options});
  if(u.hostname==='oauth2.googleapis.com')return response({access_token:'fake-access',refresh_token:'fake-refresh',expires_in:3600,scope:GOOGLE_SCOPES.join(' ')});
  if(u.pathname.endsWith('/calendarList'))return mode?response({error:'Do not leak fake-access'},401):response({items:[account,other]});
  if(u.pathname.endsWith('/events'))return events?events(u,options):response({items:[event()]});
  throw new Error('Unexpected URL');
 }});
 await service.configure({credentials:{installed:{client_id:'test.apps.googleusercontent.com',client_secret:'fake-client-secret'}}});
 const auth=await service.authorize(),state=new URL(auth.authorizationUrl).searchParams.get('state');
 if(!failList)await service.callback(new URLSearchParams({state,code:'fake-code'}));
 return{...f,service,calls,state,setIdentity:value=>{account=value;},setListFailure:value=>{mode=value;}};
}
test('OAuth uses read-only scopes, PKCE and one-use state; secrets persist only in private storage',async t=>{
 const {service,workspace,privateRoot,calls}=await connected(t);
 const publicState=await service.status(),text=JSON.stringify(publicState);
 assert.equal(publicState.account,primary.id);assert.equal(publicState.connected,true);assert.equal(publicState.readOnly,true);
 for(const secret of ['fake-access','fake-refresh','fake-client-secret'])assert.ok(!text.includes(secret));
 const exchange=calls.find(c=>c.url.hostname==='oauth2.googleapis.com'),params=new URLSearchParams(exchange.options.body);
 assert.equal(params.get('grant_type'),'authorization_code');assert.ok(params.get('code_verifier').length>=43);
 assert.equal(params.get('redirect_uri'),'http://127.0.0.1:4191/api/calendar/google/callback');
 await assert.rejects(service.callback(new URLSearchParams({state:'invalid',code:'fake'})),/state/);
 assert.equal((await stat(join(privateRoot,'connection.json'))).mode&0o777,0o600);
 assert.equal((await stat(privateRoot)).mode&0o777,0o700);
 assert.deepEqual(await readdir(join(workspace,'records')),['calendar.json','commitments.json','days']);
 assert.equal((await readCalendar(workspace)).events.length,0);
 const next=await service.authorize(),authURL=new URL(next.authorizationUrl);
 assert.equal(authURL.hostname,'accounts.google.com');assert.equal(authURL.searchParams.get('code_challenge_method'),'S256');
 assert.deepEqual(authURL.searchParams.get('scope').split(' '),GOOGLE_SCOPES);
 await assert.rejects(service.callback(new URLSearchParams({state:authURL.searchParams.get('state'),error:'access_denied'})),/not completed/);
 await assert.rejects(service.callback(new URLSearchParams({state:authURL.searchParams.get('state'),code:'replay'})),/state/);
});
test('paginated snapshots deduplicate across syncs, retain local records and minimize Google data',async t=>{
 let phase=0;
 const f=await connected(t,{events:url=>url.searchParams.has('pageToken')?response({items:[{id:'day',summary:'Workshop',status:'confirmed',start:{date:'2026-10-21'},end:{date:'2026-10-23'}}]}):response({items:[{...event('one',phase?'Updated meeting':'A meeting'),recurringEventId:'series',originalStartTime:{dateTime:'2026-11-01T01:30:00-04:00'}}],nextPageToken:'page-2'})});
 const original=emptyCalendar();original.sources.push({id:'outlook',provider:'outlook'});original.events.push({id:'local',title:'Local',status:'confirmed',allDay:true,startDate:'2026-10-22',endDate:'2026-10-23',timeZone:'America/New_York'},{id:'o',title:'Outlook',status:'confirmed',allDay:true,startDate:'2026-10-22',endDate:'2026-10-23',timeZone:'America/New_York',sourceId:'outlook',sourceEventId:'o'});original.workBlocks.push({id:'w',title:'Planned work',startAt:'2026-10-22T10:00:00-04:00',endAt:'2026-10-22T11:00:00-04:00',timeZone:'America/New_York',status:'planned'});
 await writeFile(join(f.workspace,'records/calendar.json'),JSON.stringify(original));
 const before=await readFile(join(f.workspace,'records/commitments.json'),'utf8');
 const first=await f.service.sync({calendarIds:[primary.id],expectedRevision:0});assert.equal(first.eventCount,2);
 const a=await readCalendar(f.workspace),stable=a.events.find(e=>e.sourceEventId==='one').id;
 phase=1;await f.service.sync({calendarIds:[primary.id],expectedRevision:1});const b=await readCalendar(f.workspace);
 assert.equal(b.events.length,4);assert.equal(b.revision,2);assert.deepEqual(b.workBlocks,original.workBlocks);
 assert.deepEqual(b.events.filter(e=>!e.sourceId||e.sourceId==='outlook'),original.events);
 assert.equal(b.events.find(e=>e.sourceEventId==='one').title,'Updated meeting');assert.equal(b.events.find(e=>e.sourceEventId==='one').id,stable);
 assert.equal(b.events.find(e=>e.sourceEventId==='one').recurringEventId,'series');assert.equal(b.events.find(e=>e.sourceEventId==='day').endDate,'2026-10-23');
 assert.equal(await readFile(join(f.workspace,'records/commitments.json'),'utf8'),before);assert.equal(await readFile(join(f.workspace,'inbox/keep.txt'),'utf8'),'Keep original');
 const saved=JSON.stringify(b);assert.ok(!saved.includes('Private body'));assert.ok(!saved.includes('attendees'));assert.ok(!saved.includes('fake-access'));
 for(const call of f.calls.filter(c=>c.url.hostname==='www.googleapis.com')){assert.equal(call.options.method,undefined);if(call.url.pathname.endsWith('/events')){assert.equal(call.url.searchParams.get('singleEvents'),'true');assert.equal(call.url.searchParams.get('showDeleted'),'true');assert.ok(!call.url.searchParams.get('fields').includes('description'));assert.ok(!call.url.searchParams.has('syncToken'));}}
});
test('partial pages, denied authorization, changed accounts and revision conflicts keep last successful data',async t=>{
 let failPage=false;
 const f=await connected(t,{events:url=>failPage?(url.searchParams.has('pageToken')?response({error:'secret'},503):response({items:[event('changed')],nextPageToken:'more'})):response({items:[event()]})});
 await f.service.sync({calendarIds:[primary.id],expectedRevision:0});const file=join(f.workspace,'records/calendar.json'),saved=await readFile(file,'utf8');
 failPage=true;await assert.rejects(f.service.sync({calendarIds:[primary.id],expectedRevision:1}),/could not complete/);assert.equal(await readFile(file,'utf8'),saved);
 assert.ok((await f.service.status()).error);failPage=false;
 f.setListFailure(true);await assert.rejects(f.service.sync({calendarIds:[primary.id],expectedRevision:1}),e=>e.status===401);assert.equal(await readFile(file,'utf8'),saved);assert.equal((await f.service.status()).needsReconnect,true);f.setListFailure(false);
 f.setIdentity({...primary,id:'other-account@example.invalid'});await assert.rejects(f.service.sync({calendarIds:[primary.id],expectedRevision:1}),/account changed/);assert.equal(await readFile(file,'utf8'),saved);f.setIdentity(primary);
 await assert.rejects(f.service.sync({calendarIds:[primary.id],expectedRevision:0}),e=>e.status===409);assert.equal(await readFile(file,'utf8'),saved);
 await assert.rejects(f.service.sync({calendarIds:['not-readable'],expectedRevision:1}),e=>e.status===409);assert.equal(await readFile(file,'utf8'),saved);
});
test('known cancellation tombstones retain occurrence identity; empty calendars succeed without false cancellations',async t=>{
 let phase=0;const f=await connected(t,{events:()=>response(phase===0?{items:[event()]}:phase===1?{items:[{id:'one',status:'cancelled'},{id:'unknown',status:'cancelled'}]}:{})});
 await f.service.sync({calendarIds:[primary.id],expectedRevision:0});const old=(await readCalendar(f.workspace)).events[0];
 phase=1;const result=await f.service.sync({calendarIds:[primary.id],expectedRevision:1});assert.equal(result.eventCount,0);assert.deepEqual((await readCalendar(f.workspace)).events,[{...old,status:'cancelled'}]);
 phase=2;await f.service.sync({calendarIds:[primary.id],expectedRevision:2});assert.deepEqual((await readCalendar(f.workspace)).events,[]);
});
test('refresh tokens renew access, disconnect removes credentials and leaves cached user records',async t=>{
 const f=await connected(t),path=join(f.privateRoot,'connection.json'),privateData=JSON.parse(await readFile(path,'utf8'));privateData.tokens.expiresAt=0;await writeFile(path,JSON.stringify(privateData));
 await f.service.sync({calendarIds:[primary.id],expectedRevision:0});assert.equal(f.calls.filter(c=>c.url.hostname==='oauth2.googleapis.com').length,2);
 const cached=await readFile(join(f.workspace,'records/calendar.json'),'utf8');await f.service.disconnect();
 assert.equal((await f.service.status()).connected,false);assert.equal((await f.service.status()).configured,true);
 const after=await readFile(path,'utf8');assert.ok(!after.includes('fake-refresh'));assert.ok(!after.includes('fake-access'));assert.ok(!after.includes(primary.id));
 assert.equal(await readFile(join(f.workspace,'records/calendar.json'),'utf8'),cached);
 await assert.rejects(f.service.sync({calendarIds:[primary.id],expectedRevision:1}),e=>e.status===428);
});
test('calendar commits reject stale concurrent writes, corrupt stores and symlink escapes',async t=>{
 const f=await fixture(t),file=join(f.workspace,'records/calendar.json');
 const results=await Promise.allSettled([1,2].map(()=>commitCalendar(f.workspace,0,c=>({...c,revision:1}))));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.find(r=>r.status==='rejected').reason.status,409);assert.equal((await readCalendar(f.workspace)).revision,1);
 await writeFile(file,'{broken');await assert.rejects(commitCalendar(f.workspace,1,c=>({...c,revision:2})),/invalid JSON/);assert.equal(await readFile(file,'utf8'),'{broken');
 const protectedFile=join(f.root,'keep.json');await writeFile(protectedFile,'untouched');await rm(file);await symlink(protectedFile,file);
 await assert.rejects(commitCalendar(f.workspace,1,c=>({...c,revision:2})),/symbolic links/);assert.equal(await readFile(protectedFile,'utf8'),'untouched');
});
test('HTTP Google interface protects mutations; invalid cross-site callbacks cannot bypass state',async t=>{
 const f=await fixture(t);let handler;
 const server=http.createServer((req,res)=>handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(done=>{server.close(done);server.closeAllConnections();}));const port=server.address().port,origin='http://127.0.0.1:'+port;
 const google=new GoogleCalendarService({...f,origin,fetchImpl:()=>{throw new Error('No network expected');},openBrowser:async()=>{}});
 handler=createRequestHandler({workspace:f.workspace,port,daily:{csrf:'test-csrf'},google});
 const status=await(await fetch(origin+'/api/calendar/google/status')).json();assert.equal(status.configured,false);assert.equal(status.connected,false);
 const post=(action,body={},headers={})=>fetch(origin+'/api/calendar/google/'+action,{method:'POST',headers:{Origin:origin,'X-RUWithMe-CSRF':'test-csrf','Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 for(const action of ['configure','authorize','calendars','sync','disconnect']){
  for(const headers of [{Origin:''},{Origin:'https://attacker.invalid'},{'X-RUWithMe-CSRF':'wrong'},{'Sec-Fetch-Site':'cross-site'}]){const r=await post(action,{},headers);assert.equal(r.status,403);await r.json();}
  const method=await fetch(origin+'/api/calendar/google/'+action);assert.equal(method.status,405);await method.json();
 }
 const missing=await post('authorize');assert.equal(missing.status,428);await missing.json();
 const invalid=await post('configure',{credentials:{web:{client_id:'ignored'}}});assert.equal(invalid.status,400);await invalid.json();
 const configure=await post('configure',{credentials:{installed:{client_id:'test.apps.googleusercontent.com',client_secret:'fake-secret'}}});assert.equal(configure.status,200);assert.ok(!JSON.stringify(await configure.json()).includes('fake-secret'));
 const start=await post('authorize');assert.equal(start.status,200);const auth=new URL((await start.json()).authorizationUrl);assert.equal(auth.searchParams.get('code_challenge_method'),'S256');
 const callback=await fetch(origin+'/api/calendar/google/callback?state=wrong&code=ignored',{headers:{'Sec-Fetch-Site':'cross-site'},redirect:'manual'});assert.equal(callback.status,400);await callback.json();
 for(const path of ['/api/file?path=.ruwithme/google-calendar/connection.json','/.ruwithme/google-calendar/connection.json']){const r=await fetch(origin+path);assert.ok(r.status>=400);await r.text();}
 assert.equal((await readCalendar(f.workspace)).events.length,0);
});
