import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

// This stdio tool runs beside the app, outside the command sandbox. Its fixed
// routes keep ordinary record access independent of shell network permissions.
const object=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const string={type:'string'},revision={type:'integer',minimum:0};
export const dailyRecordTools=[
 {name:'read_records',description:'Read the saved RUWithMe workspace, commitments, Todos, calendar projection, work sessions, histories, Track drafts/revisions and latest real user message. Read source notes separately when needed. No synchronization or changes.',inputSchema:object(),annotations:{readOnlyHint:true,openWorldHint:false}},
 {name:'propose_track',description:'Stage or revise an advisory daily plan, evening summary or weekly review for discussion. Does not confirm/save a daily record, create Todos or change Calendar. Read current revisions first; preserve conflicts.',inputSchema:object({requestId:string,expectedRevision:revision,date:string,type:{type:'string',enum:['plan','summary','weekly']},content:{type:'object'},id:string,expectedDraftRevision:revision},['requestId','expectedRevision','date','type','content']),annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},
 {name:'confirm_track',description:'Save the latest reviewed Track draft only after the user explicitly says Confirm and save in a later Daily message. Requires that real latest user message ID. Corrections require a new draft and another confirmation.',inputSchema:object({id:string,expectedRevision:revision,expectedDraftRevision:revision,confirmationMessageId:string},['id','expectedRevision','expectedDraftRevision','confirmationMessageId']),annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}}
];
export function localRecordsOrigin(value){
 let url;try{url=new URL(value);}catch{throw new Error('A configured local RUWithMe origin is required.');}
 if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Only the configured loopback origin is supported.');
 return url.origin;
}
export function createDailyRecordsTools({origin,fetchImpl=fetch}){
 origin=localRecordsOrigin(origin);
 async function request(path,{body,csrf}={}){
  let response;
  try{response=await fetchImpl(origin+path,{method:body?'POST':'GET',headers:{Origin:origin,...(body?{'Content-Type':'application/json','X-RUWithMe-CSRF':csrf}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw new Error('RUWithMe is unavailable at its configured local origin. Keep the draft and retry after reconnecting the app.');}
  const raw=await response.text();if(raw.length>2*1024*1024)throw new Error('The local record response is too large. Inspect the relevant saved source files.');
  let data;try{data=JSON.parse(raw);}catch{throw new Error('RUWithMe returned an invalid record response.');}
  if(!response.ok)throw new Error('RUWithMe request failed ('+response.status+'): '+String(data.error||'Review the latest records.').slice(0,1000));
  return data;
 }
 return async(name,args={})=>{
  const tool=dailyRecordTools.find(t=>t.name===name);
  if(!tool)throw new Error('Unknown RUWithMe record tool.');
  const schema=tool.inputSchema;
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!Object.hasOwn(schema.properties,k))||schema.required.some(k=>!Object.hasOwn(args,k)))throw new Error('Use only the documented record tool arguments.');
  if(name==='read_records'){
   const [workspace,track]=await Promise.all([request('/api/workspace'),request('/api/track')]);
   return{workspace,track};
  }
  // Never offer the browser-only confirmed:true shortcut to the model.
  if(name==='confirm_track'&&(typeof args.confirmationMessageId!=='string'||!args.confirmationMessageId.trim()))throw new Error('A real explicit user confirmation message is required.');
  const session=await request('/api/codex/session');
  if(typeof session.csrf!=='string'||!session.csrf)throw new Error('Reconnect Daily before staging or confirming a draft.');
  const result=await request(name==='propose_track'?'/api/track/propose':'/api/track/confirm',{body:args,csrf:session.csrf});
  // Session/authentication data never leaves this process or enters tool output.
  return result;
 };
}

export function serveDailyRecords({origin,input=process.stdin,output=process.stdout,fetchImpl=fetch}){
 const call=createDailyRecordsTools({origin,fetchImpl}),lines=createInterface({input});
 const send=value=>output.write(JSON.stringify(value)+'\n');
 lines.on('line',async line=>{
  let message;
  try{if(line.length>128000)throw new Error();message=JSON.parse(line);}catch{send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON-RPC message.'}});return;}
  if(message.id===undefined)return;
  const {id,method,params={}}=message;
  if(method==='initialize'){send({jsonrpc:'2.0',id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'ruwithme-daily-records',version:'1.0.0'}}});return;}
  if(method==='ping'){send({jsonrpc:'2.0',id,result:{}});return;}
  if(method==='tools/list'){send({jsonrpc:'2.0',id,result:{tools:dailyRecordTools}});return;}
  if(method!=='tools/call'){send({jsonrpc:'2.0',id,error:{code:-32601,message:'Method not supported.'}});return;}
  try{const result=await call(params.name,params.arguments);send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}],isError:false}});}
  catch{send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:'RUWithMe could not complete this record request. Read current records and check revisions, required fields and explicit confirmation. No success is claimed.'}],isError:true}});}
 });
 return lines;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))serveDailyRecords({origin:process.argv[2]});
