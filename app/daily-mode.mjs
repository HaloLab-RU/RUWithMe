import {open,readFile,mkdir,realpath,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {indexWorkspace} from './workspace.mjs';
import {readRecords} from './records.mjs';
import {readWorkspaceMode,sampleCandidates} from './demo.mjs';
import {writePrivateJSON,ensureCalendarFolder} from './google-calendar.mjs';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export async function modePreview(root){
 const index=await indexWorkspace(root),candidates=sampleCandidates(await readRecords(root));
 return{revision:index.revision,daily:!index.demo,timeZone:index.records.calendar.timeZone,startedAt:index.mode?.startedAt||null,groups:Object.fromEntries(Object.entries({...candidates,workspaces:index.sampleWorkspaces.filter(row=>row.eligible),inboxFiles:index.sampleInbox.filter(row=>row.eligible&&row.kind==='file'),inboxIdeas:index.sampleInbox.filter(row=>row.eligible&&row.kind==='idea')}).map(([key,rows])=>[key,rows.map(row=>({id:row.id,title:row.title||row.workedOn||(row.type==='plan'?'Daily plan':row.type==='summary'?'Daily summary':'Weekly review'),date:row.date||row.dueDate||row.startDate||row.startAt?.slice(0,10)||'',archived:index.mode?.archived[key]?.includes(row.id)||false}))])),protectedWorkspaces:index.sampleWorkspaces.filter(row=>!row.eligible),protectedInbox:index.sampleInbox.filter(row=>!row.eligible),preserved:{workspaces:Object.values(index.items).flat().length,files:Object.values(index.items).flat().reduce((sum,row)=>sum+row.files.length,0),manualAndEditedRecords:true}};
}
export async function startDailyMode(root,{expectedRevision,archive,confirmed,operationId}={},now=()=>new Date()){
 if(confirmed!==true||typeof operationId!=='string'||!/^[0-9a-f-]{36}$/i.test(operationId)||!archive||Object.keys(archive).some(key=>!['tasks','calendar','sessions','track','workspaces','inbox'].includes(key))||['workspaces','inbox'].some(key=>archive[key]!==undefined&&typeof archive[key]!=='boolean')||!['tasks','calendar','sessions','track'].every(key=>typeof archive[key]==='boolean'))throw fail('Review what to keep, then confirm daily mode.');
 const base=await realpath(root),lockPath=resolve(base,'.daily-mode.lock');let lock;
 try{
  try{lock=await open(lockPath,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw fail('Workspace mode is being changed. Try again shortly.',409);throw error;}
  const current=await readWorkspaceMode(base);archive={...archive,workspaces:archive.workspaces??current?.selection?.workspaces??false,inbox:archive.inbox??current?.selection?.inbox??false};if(current?.operationId===operationId){if(['tasks','calendar','sessions','track','workspaces','inbox'].every(key=>(current.selection?.[key]||false)===(archive[key]||false)))return current;throw fail('The previous attempt saved different choices. Review the current settings before changing them.',409);}
  const preview=await modePreview(base);if(preview.revision!==expectedRevision)throw fail('Workspace content changed. Review the latest preview before starting.',409);
  const candidates=sampleCandidates(await readRecords(base)),archived={};for(const key of Object.keys(candidates)){const group=['events','blocks'].includes(key)?'calendar':['entries','drafts'].includes(key)?'track':key;archived[key]=archive[group]?candidates[key].map(row=>row.id):[];}
  archived.workspaces=archive.workspaces?(await indexWorkspace(base)).sampleWorkspaces.filter(row=>row.eligible).map(row=>row.id):[];
  const inboxSamples=(await indexWorkspace(base)).sampleInbox;
  for(const [key,kind] of [['inboxFiles','file'],['inboxIdeas','idea']])archived[key]=archive.inbox?inboxSamples.filter(row=>row.eligible&&row.kind===kind).map(row=>row.id):[];
  const startedAt=current?.startedAt||now().toISOString(),mode={version:1,mode:'daily',synthetic:false,startedAt,updatedAt:now().toISOString(),operationId,archived,selection:{...archive},filesPreserved:true};
  if(Buffer.byteLength(JSON.stringify(mode))>2*1024*1024-1000)throw fail('Sample visibility settings have reached their supported size.',413);
  const privateDir=resolve(base,'../.ruwithme'),backups=resolve(privateDir,'backups'),folder=resolve(backups,'daily-mode');await ensureCalendarFolder(privateDir);await ensureCalendarFolder(backups);await ensureCalendarFolder(folder);
  const backup=resolve(folder,operationId);await mkdir(backup,{mode:0o700,recursive:true});await ensureCalendarFolder(backup);
  let prior;try{prior=JSON.parse(await readFile(resolve(base,'.demo.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  await writePrivateJSON(resolve(backup,'previous-mode.json'),{existed:prior!==undefined,value:prior||null});await writePrivateJSON(resolve(backup,'selection.json'),{mode,note:'This is a reversible view filter. All original files and record stores remain unchanged. To undo, restore the previous .demo.json settings, or review sample visibility in the app.'});
  mode.backupId=operationId;await writePrivateJSON(resolve(base,'.demo.json'),mode);return mode;
 }finally{if(lock){await lock.close();await unlink(lockPath).catch(()=>{});}}
}
export async function handleDailyModeRequest(req,res,{workspace,daily,origin,json}){
 const path=new URL(req.url,origin).pathname;if(!['/api/workspace/mode','/api/workspace/mode/start'].includes(path))return false;
 if(path==='/api/workspace/mode'&&req.method==='GET'){json(res,200,await modePreview(workspace));return true;}
 if(path!=='/api/workspace/mode/start'||req.method!=='POST'){json(res,405,{error:'Method not allowed'});return true;}
 if(req.headers.origin!==origin||req.headers['x-ruwithme-csrf']!==daily.csrf){json(res,403,{error:'Refresh before changing workspace mode.'});return true;}
 if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json'){json(res,415,{error:'JSON required'});return true;}
 let size=0;const chunks=[];for await(const chunk of req.iterator({destroyOnReturn:false})){size+=chunk.length;if(size>16000)throw fail('Request too large',413);chunks.push(chunk);}
 const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!input||typeof input!=='object'||Array.isArray(input))throw fail('A JSON object is required.');json(res,200,await startDailyMode(workspace,input));return true;
}
