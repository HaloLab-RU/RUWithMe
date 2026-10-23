import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {CodexCalendarService,connectorData} from '../app/codex-calendar.mjs';
import {CodexService} from '../app/codex-service.mjs';
import {emptyCalendar,readCalendar} from '../app/records.mjs';
import {createRequestHandler} from '../app/server.mjs';
const reply=structuredContent=>({structuredContent,isError:false,content:[]});
async function fixture(t){
 const root=await realpath(await mkdtemp(join(tmpdir(),'ru-codex-calendar-'))),workspace=join(root,'workspace'),privateRoot=join(root,'.ruwithme/calendar');
 for(const folder of ['research','courses','learn','inbox','records/days'])await mkdir(join(workspace,folder),{recursive:true});
 await writeFile(join(workspace,'records/calendar.json'),JSON.stringify(emptyCalendar()));await writeFile(join(workspace,'inbox/keep.txt'),'Original');
 t.after(()=>rm(root,{recursive:true,force:true}));return{root,workspace,privateRoot};
}
const timed=(title='A meeting')=>({id:'one',summary:title,status:'confirmed',start:'2026-11-01T01:30:00-04:00',end:'2026-11-01T01:30:00-05:00',description:'private body',organizer:{email:'private@example.invalid'},recurring_event_id:'series',original_start_time:'2026-11-01T01:30:00-04:00',url:'https://calendar.google.com/calendar/event?eid=test'});
async function serviceFixture(t,{page,connected=true}={}){
 const f=await fixture(t),calls=[];let identity='profile-1',account='test@example.invalid';
 const daily={csrf:'test-csrf',calendarCapabilities:async()=>({connected,canWrite:true}),calendarTool:async(name,args)=>{
  calls.push({name,args});
  if(name==='get_profile')return reply({id:identity,email:account,picture:'Do not store'});
  if(name==='list_calendars')return reply({calendars:[{id:account,summary:'Primary',primary:true,access_role:'owner'},{id:'study',summary:'Study',primary:false,access_role:'reader'},{id:'busy',summary:'Busy only',primary:false,access_role:'freeBusyReader'}],next_page_token:null});
  if(name==='search_events')return page?page(args):reply({events:[timed()],next_page_token:null});
  throw new Error('Unexpected tool');
 }};
 const service=new CodexCalendarService({...f,daily,now:()=>new Date('2026-10-20T12:00:00Z')});
 return{...f,service,daily,calls,setIdentity:(id,email=account)=>{identity=id;account=email;}};
}
test('Codex sync uses existing connector reads with no OAuth, no inference turn and minimal records',async t=>{
 const f=await serviceFixture(t),status=await f.service.status();assert.equal(status.via,'codex');assert.equal(status.connected,true);assert.equal(status.canWrite,true);assert.deepEqual(status.selectedCalendarIds,['test@example.invalid']);assert.equal(status.calendars.length,2);
 const result=await f.service.sync({calendarIds:status.selectedCalendarIds,expectedRevision:0});assert.equal(result.eventCount,1);const calendar=await readCalendar(f.workspace),event=calendar.events[0];
 assert.equal(event.startAt,'2026-11-01T01:30:00-04:00');assert.equal(event.endAt,'2026-11-01T01:30:00-05:00');assert.equal(event.recurringEventId,'series');assert.equal(event.originalStartAt,event.startAt);
 const text=JSON.stringify(calendar);assert.ok(!text.includes('private body'));assert.ok(!text.includes('private@example'));assert.ok(!text.includes('Do not store'));
 assert.ok(f.calls.every(c=>['get_profile','list_calendars','search_events'].includes(c.name)));
 assert.equal(await readFile(join(f.workspace,'inbox/keep.txt'),'utf8'),'Original');
 const prefs=await readFile(join(f.privateRoot,'preferences.json'),'utf8');assert.ok(!prefs.includes('token'));assert.ok(!prefs.includes('secret'));assert.equal((await stat(join(f.privateRoot,'preferences.json'))).mode&0o777,0o600);
 await assert.rejects(f.service.configure({}),/not needed/);await assert.rejects(f.service.authorize({}),/Codex/);
});
test('Codex pagination, normalized all-day events, empty calendars and repeat syncs round-trip',async t=>{
 let phase=0;const f=await serviceFixture(t,{page:args=>reply(phase===2?{events:[],next_page_token:null}:args.next_page_token?{events:[{id:'day',summary:'Workshop',status:'confirmed',start:'2026-10-21',end:'2026-10-23'}],next_page_token:null}:{events:[timed(phase?'Updated':'A meeting')],next_page_token:'p2'})});
 const opts={calendarIds:['test@example.invalid'],expectedRevision:0};await f.service.sync(opts);const a=await readCalendar(f.workspace);assert.equal(a.events.length,2);const id=a.events[0].id;
 phase=1;await f.service.sync({...opts,expectedRevision:1});const b=await readCalendar(f.workspace);assert.equal(b.events.length,2);assert.equal(b.events[0].id,id);assert.equal(b.events[0].title,'Updated');assert.equal(b.events[1].endDate,'2026-10-23');
 const pages=f.calls.filter(c=>c.name==='search_events');assert.ok(pages.every(c=>c.args.time_min==='2026-09-20T00:00:00.000Z'&&c.args.time_max==='2027-04-19T00:00:00.000Z'));assert.ok(pages.some(c=>c.args.next_page_token==='p2'));
 phase=2;await f.service.sync({...opts,expectedRevision:2});assert.deepEqual((await readCalendar(f.workspace)).events,[]);
});
test('failed pages, account switches, repeated cursors and stale writes cannot replace last successful capture',async t=>{
 let mode='good',f;f=await serviceFixture(t,{page:args=>{
  if(mode==='failed'&&args.next_page_token)return{isError:true,content:[{type:'text',text:'Connector blocked'}]};
  if(mode==='failed'||mode==='loop')return reply({events:[timed('Must not save')],next_page_token:'same'});
  if(mode==='switch')f.setIdentity('another-profile','another@example.invalid');
  return reply({events:[timed()],next_page_token:null});
 }});
 const opts={calendarIds:['test@example.invalid'],expectedRevision:0};await f.service.sync(opts);const path=join(f.workspace,'records/calendar.json'),saved=await readFile(path,'utf8');
 for(const failure of ['failed','loop','switch']){mode=failure;await assert.rejects(f.service.sync({...opts,expectedRevision:1}));assert.equal(await readFile(path,'utf8'),saved);f.setIdentity('profile-1','test@example.invalid');}
 mode='good';const before=f.calls.length;await assert.rejects(f.service.sync(opts),e=>e.status===409);assert.equal(f.calls.length,before);assert.equal(await readFile(path,'utf8'),saved);
});
test('missing Codex permission is reported honestly without independent OAuth or fabricated events',async t=>{
 const f=await serviceFixture(t,{connected:false}),state=await f.service.status();assert.equal(state.connected,false);assert.equal(state.via,'codex');assert.match(state.error,/Codex/);assert.deepEqual(f.calls,[]);
 await assert.rejects(f.service.sync({calendarIds:['primary'],expectedRevision:0}),e=>e.status===428);assert.equal((await readCalendar(f.workspace)).revision,0);
});
test('Codex calendar RPCs reuse one Daily thread and refuse arbitrary or write tools',async()=>{
 const calls=[],daily=new CodexService({workspaceRoot:'/mock/workspace',sessionFile:'/mock/session'});daily.ready=async()=>{};daily.save=async()=>{};
 daily.rpc=async(method,params)=>{calls.push({method,params});if(method==='thread/start')return{thread:{id:'daily-thread'},model:'model'};if(method==='mcpServer/tool/call')return reply({events:[]});throw new Error('Unexpected RPC');};
 await daily.calendarTool('search_events',{calendar_id:'primary'});await daily.calendarTool('get_profile',{});
 assert.equal(calls.filter(c=>c.method==='thread/start').length,1);assert.ok(!calls.some(c=>c.method==='turn/start'));
 for(const call of calls.filter(c=>c.method==='mcpServer/tool/call')){assert.equal(call.params.threadId,'daily-thread');assert.equal(call.params.server,'codex_apps');}
 await assert.rejects(daily.calendarTool('update_event',{}),/Only calendar reads/);await assert.rejects(daily.calendarTool('gmail.send',{}),/Only calendar reads/);
});
test('real HTTP sync route uses Codex transport and protects CSRF without accepting client captures',async t=>{
 const f=await serviceFixture(t);let handler;const server=http.createServer((req,res)=>handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(done=>{server.close(done);server.closeAllConnections();}));const port=server.address().port,origin='http://127.0.0.1:'+port;
 handler=createRequestHandler({workspace:f.workspace,daily:f.daily,google:f.service,port});
 const state=await(await fetch(origin+'/api/calendar/google/status')).json();assert.equal(state.connected,true);assert.equal(state.via,'codex');
 const post=(body,token='test-csrf')=>fetch(origin+'/api/calendar/google/sync',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-RUWithMe-CSRF':token},body:JSON.stringify(body)});
 const blocked=await post({calendarIds:state.selectedCalendarIds,expectedRevision:0},'bad');assert.equal(blocked.status,403);await blocked.json();assert.equal((await readCalendar(f.workspace)).revision,0);
 const r=await post({calendarIds:state.selectedCalendarIds,expectedRevision:0,events:[{title:'Fake from browser'}]});assert.equal(r.status,200);assert.equal((await r.json()).via,'codex');assert.equal((await readCalendar(f.workspace)).events[0].title,'A meeting');
});

test('connector midnight date boundaries stay date-based; ambiguous floating clock times cannot overwrite records',async t=>{
 let floating=false;
 const f=await serviceFixture(t,{page:()=>reply({events:[{id:'date',summary:'Date event',status:'confirmed',start:floating?'2026-10-21T14:00:00':'2026-10-21T00:00:00',end:floating?'2026-10-21T15:00:00':'2026-10-23T00:00:00'}],next_page_token:null})});
 await f.service.sync({calendarIds:['test@example.invalid'],expectedRevision:0});const a=await readCalendar(f.workspace),event=a.events[0];assert.equal(event.allDay,true);assert.equal(event.startDate,'2026-10-21');assert.equal(event.endDate,'2026-10-23');assert.equal(event.sourceDateEncoding,'connector-midnight');assert.equal(event.startAt,undefined);
 const saved=await readFile(join(f.workspace,'records/calendar.json'),'utf8');floating=true;await assert.rejects(f.service.sync({calendarIds:['test@example.invalid'],expectedRevision:1}),/explicit-offset/);assert.equal(await readFile(join(f.workspace,'records/calendar.json'),'utf8'),saved);
});

test('connector approval denials retain a bounded reason instead of claiming a successful write',()=>{
 assert.throws(()=>connectorData({isError:true,structuredContent:{error:{message:'Automatic approval review denied: calendar action requires review.'}}}),/approval review denied/);
});
