import {open,realpath,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {readSessions,validateSessions,validDate,readCalendar} from './records.mjs';
import {indexWorkspace,safeFile} from './workspace.mjs';
import {ensureCalendarFolder,writePrivateJSON} from './google-calendar.mjs';
import {localDate} from './todos.mjs';
import {workspaceDay} from './demo.mjs';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export class SessionService{
 constructor({workspace,now=()=>new Date()}){Object.assign(this,{workspace,now});}
 async save(input){
  if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||typeof input.id!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.id))throw fail('Read the current sessions revision and supply a session ID.');
  const {timeZone}=await readCalendar(this.workspace),today=await workspaceDay(this.workspace,this.now(),timeZone);
  if(!validDate(input.date)||input.date>today)throw fail('Choose today or an earlier work date.');
  const value={date:input.date,timeZone,ownerPath:input.ownerPath||null};
  for(const key of ['workedOn','outcome','blockers','nextStep']){const text=input[key]??'';if(typeof text!=='string'||text.length>6000||key==='workedOn'&&!text.trim())throw fail('Describe what you worked on; each field supports up to 6,000 characters.');value[key]=text.trim();}
  if(!Array.isArray(input.files)||input.files.length>20||input.files.some(p=>typeof p!=='string'))throw fail('Choose up to 20 existing workspace files.');
  value.files=[...new Set(input.files)];for(const path of value.files)await safeFile(this.workspace,path);
  if(value.ownerPath){const index=await indexWorkspace(this.workspace);if(!Object.values(index.items).flat().some(item=>item.path===value.ownerPath))throw fail('Choose an existing workspace.',404);}
  const root=await realpath(this.workspace),dir=resolve(root,'records');await ensureCalendarFolder(dir);let lock;
  try{
   try{lock=await open(resolve(dir,'.sessions.lock'),'wx',0o600);}catch(e){if(e.code==='EEXIST')throw fail('Sessions are being updated. Keep your draft and try again.',409);throw e;}
   const data=await readSessions(root),existing=data.items.find(row=>row.id===input.id);
   if(existing&&input.expectedItemRevision===undefined){if(Object.keys(value).every(k=>JSON.stringify(existing[k])===JSON.stringify(value[k])))return existing;throw fail('This session ID is already in use. Review its saved content.',409);}
   if(data.revision!==input.expectedRevision)throw fail('Sessions changed. Your form is preserved; review the latest records before saving again.',409);
   const at=new Date(Math.max(this.now().getTime(),existing?Date.parse(existing.updatedAt)+1:0)).toISOString();let row;
   if(input.expectedItemRevision!==undefined){
    if(!existing||existing.revision!==input.expectedItemRevision)throw fail('This session changed. Keep your draft and review its latest version.',409);
    const {versions,...previous}=existing;row={...existing,...value,revision:existing.revision+1,updatedAt:at,versions:[...versions,previous]};data.items[data.items.indexOf(existing)]=row;
   }else{row={id:input.id,...value,revision:1,createdAt:at,updatedAt:at,versions:[]};data.items.push(row);}
   data.revision++;validateSessions(data);if(Buffer.byteLength(JSON.stringify(data))>4*1024*1024)throw fail('Session records have reached their supported size.',413);
   await writePrivateJSON(resolve(dir,'sessions.json'),data);return row;
  }finally{if(lock){await lock.close();await unlink(resolve(dir,'.sessions.lock')).catch(()=>{});}}
 }
}
export async function handleSessionRequest(req,res,{service,daily,origin,json}){
 const path=new URL(req.url,origin).pathname;if(path!=='/api/sessions'&&path!=='/api/sessions/save')return false;
 if(path==='/api/sessions'&&req.method==='GET'){json(res,200,await readSessions(service.workspace));return true;}
 if(path!=='/api/sessions/save'||req.method!=='POST'){json(res,405,{error:'Method not allowed'});return true;}
 if(req.headers.origin!==origin||req.headers['x-ruwithme-csrf']!==daily.csrf){json(res,403,{error:'Refresh before saving a work session.'});return true;}
 if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json'){json(res,415,{error:'JSON required'});return true;}
 let size=0;const chunks=[];for await(const chunk of req.iterator({destroyOnReturn:false})){size+=chunk.length;if(size>64000){req.resume();json(res,413,{error:'Request too large'});return true;}chunks.push(chunk);}
 const input=JSON.parse(Buffer.concat(chunks,size).toString('utf8'));if(!input||typeof input!=='object'||Array.isArray(input))throw fail('A JSON object is required.');json(res,200,await service.save(input));return true;
}
