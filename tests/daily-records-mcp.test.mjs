import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createDailyRecordsTools,localRecordsOrigin} from '../app/daily-records-mcp.mjs';
import {createRequestHandler} from '../app/server.mjs';
import {emptyCalendar,emptyCommitments,emptyTrack,readTrack} from '../app/records.mjs';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'ru-daily-record-tools-')),workspace=join(root,'workspace');
 for(const name of ['research','courses','learn','career','admin','personal','inbox','records/days'])await mkdir(join(workspace,name),{recursive:true});
 for(const [name,data] of [['calendar',emptyCalendar()],['commitments',emptyCommitments()],['track',emptyTrack()]])await writeFile(join(workspace,'records',name+'.json'),JSON.stringify(data));
 const daily={csrf:'PRIVATE_SYNTHETIC_CSRF',active:null,data:{messages:[]},load:async()=>{},status:async()=>({csrf:daily.csrf,account:{email:'PRIVATE_SYNTHETIC_ACCOUNT'},messages:[]})};
 let handler;const server=http.createServer((req,res)=>handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');
 const port=server.address().port,origin='http://127.0.0.1:'+port;handler=createRequestHandler({workspace,daily,port});
 t.after(async()=>{server.closeAllConnections();await new Promise(done=>server.close(done));await rm(root,{recursive:true,force:true});});
 return{root,workspace,daily,origin,call:createDailyRecordsTools({origin})};
}
const plan={priorities:['Read the saved research note'],schedule:['Suggested: one reading block'],notes:'Advice only; create Todos manually.'};

test('record tools read canonical data, stage a draft and require later real confirmation through existing APIs',async t=>{
 const f=await fixture(t),task=join(f.workspace,'records/commitments.json'),calendar=join(f.workspace,'records/calendar.json'),before=await Promise.all([readFile(task,'utf8'),readFile(calendar,'utf8')]);
 let state=await f.call('read_records',{});assert.equal(state.track.revision,0);assert.deepEqual(state.workspace.records.track.entries,[]);
 const draft=await f.call('propose_track',{requestId:randomUUID(),expectedRevision:0,date:'2026-10-21',type:'plan',content:plan});
 assert.equal(draft.status,'pending');assert.equal((await readTrack(f.workspace)).entries.length,0);
 const args={id:draft.id,expectedRevision:1,expectedDraftRevision:1,confirmationMessageId:'real-confirmation'};
 await assert.rejects(f.call('confirm_track',args),/409/);assert.equal((await readTrack(f.workspace)).entries.length,0);
 await assert.rejects(f.call('confirm_track',{...args,confirmed:true}),/documented/);
 await assert.rejects(f.call('propose_track',{requestId:randomUUID(),expectedRevision:0,date:'2026-10-21',type:'plan',content:plan}),/409/);
 f.daily.data.messages.push({id:'real-confirmation',role:'user',text:'Confirm and save',time:new Date(Date.now()+1000).toISOString()});
 const entry=await f.call('confirm_track',args);assert.equal(entry.confirmation.method,'chat');assert.deepEqual(entry.content,plan);
 state=await f.call('read_records',{});assert.equal(state.track.entries.length,1);assert.equal(state.track.latestUserMessage.id,'real-confirmation');
 assert.deepEqual(await Promise.all([readFile(task,'utf8'),readFile(calendar,'utf8')]),before);
 assert.ok(!JSON.stringify([draft,entry,state]).includes(f.daily.csrf));assert.ok(!JSON.stringify([draft,entry,state]).includes('PRIVATE_SYNTHETIC_ACCOUNT'));
});

test('record tools cannot select arbitrary hosts, routes, credentials or browser-only confirmation',async()=>{
 for(const origin of ['https://127.0.0.1:4191','http://example.com:4191','http://127.0.0.1','http://u:p@localhost:4191','http://127.0.0.1:4191/private','http://localhost:4191/?token=x'])assert.throws(()=>localRecordsOrigin(origin));
 let calls=0;const call=createDailyRecordsTools({origin:'http://127.0.0.1:4191',fetchImpl:async()=>{calls++;throw new Error('Must not fetch.');}});
 for(const [name,args] of [['arbitrary',{}],['read_records',{path:'/api/codex/session'}],['read_records',{url:'https://other.invalid'}],['read_records',[]],['confirm_track',{id:'x',expectedRevision:0,expectedDraftRevision:0,confirmationMessageId:'',confirmed:true}]])await assert.rejects(call(name,args));
 assert.equal(calls,0);
});

test('the real stdio MCP process lists tools and reads records without exposing session data',async t=>{
 const f=await fixture(t),child=spawn(process.execPath,[new URL('../app/daily-records-mcp.mjs',import.meta.url).pathname,f.origin],{stdio:['pipe','pipe','pipe']}),pending=new Map(),lines=createInterface({input:child.stdout});let seq=0,stderr='';
 child.stderr.on('data',b=>stderr+=b);lines.on('line',line=>{const result=JSON.parse(line);pending.get(result.id)?.(result);pending.delete(result.id);});
 t.after(()=>{child.kill();lines.close();});
 const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>reject(new Error('MCP response timed out.')),5000);pending.set(id,value=>{clearTimeout(timer);resolve(value);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 const init=await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'1'}});assert.ok(init.result.capabilities.tools);
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 const list=await rpc('tools/list');assert.deepEqual(list.result.tools.map(t=>t.name),['read_records','propose_track','confirm_track']);
 const read=await rpc('tools/call',{name:'read_records',arguments:{}});assert.equal(read.result.isError,false);assert.equal(JSON.parse(read.result.content[0].text).track.revision,0);
 const refused=await rpc('tools/call',{name:'read_records',arguments:{path:'/api/codex/session'}});assert.equal(refused.result.isError,true);assert.ok(!JSON.stringify([read,refused]).includes(f.daily.csrf));assert.equal(stderr,'');
});
