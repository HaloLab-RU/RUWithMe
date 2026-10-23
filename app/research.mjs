import {constants} from 'node:fs';
import {readdir,realpath,lstat,open,mkdir,rename,unlink,rmdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const levels=['p1','p2','p3'],queues=new Map(),MAX_BYTES=4*1024*1024;
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const empty=()=>({version:1,revision:0,levels:{p1:[],p2:[],p3:[]}});
const projectId=path=>createHash('sha256').update(path).digest('hex').slice(0,20);
const validPriority=priority=>priority===null||levels.includes(priority);
function projectPath(path){
 if(typeof path!=='string'||!/^research\/[^/.][^/]*\/README\.md$/.test(path)||/[\\\p{Cc}]/u.test(path)||Buffer.byteLength(path.split('/')[1])>255)throw fail('Invalid Research project path in priority store.',422);
 return path;
}
async function directory(base,{create=false}={}){
 const folder=resolve(base,'research');let info;
 try{info=await lstat(folder);}catch(e){if(e.code!=='ENOENT')throw e;if(!create)return null;await mkdir(folder);info=await lstat(folder);}
 if(!info.isDirectory()||info.isSymbolicLink()||await realpath(folder)!==folder)throw fail('Research cannot use symbolic links.',403);
 return folder;
}
async function safeProject(base,path,{missing=false}={}){
 projectPath(path);await directory(base);
 const folder=resolve(base,path.slice(0,-10)),file=resolve(base,path);
 try{
  const parent=await lstat(folder);
  if(!parent.isDirectory()||parent.isSymbolicLink()||await realpath(folder)!==folder)throw fail('Research projects cannot use symbolic links.',403);
  const info=await lstat(file);
  if(!info.isFile()||info.isSymbolicLink())throw fail('Research README must be a regular file.',403);
  return file;
 }catch(e){if(missing&&e.code==='ENOENT')return null;throw e;}
}
async function readStore(base){
 const folder=await directory(base);if(!folder)return empty();
 let handle;
 try{
  handle=await open(resolve(folder,'.priorities.json'),constants.O_RDONLY|constants.O_NOFOLLOW);
  const info=await handle.stat();if(!info.isFile()||info.size>MAX_BYTES)throw fail('Research priority store is invalid or too large.',422);
  let data;try{data=JSON.parse(await handle.readFile('utf8'));}catch(e){if(e instanceof SyntaxError)throw fail('Research priority store is corrupt; repair it before making changes.',422);throw e;}
  if(!data||data.version!==1||!Number.isSafeInteger(data.revision)||data.revision<0||!data.levels||typeof data.levels!=='object'||Object.keys(data.levels).length!==3||!levels.every(level=>Array.isArray(data.levels[level])))throw fail('Research priority store has an unsupported format.',422);
  const seen=new Set();
  for(const level of levels)for(const path of data.levels[level]){
   projectPath(path);if(seen.has(path)||seen.size>=2000)throw fail('Research priority store contains duplicate or excessive projects.',422);
   seen.add(path);await safeProject(base,path,{missing:true});
  }
  return{version:1,revision:data.revision,levels:Object.fromEntries(levels.map(level=>[level,[...data.levels[level]]]))};
 }catch(e){if(e.code==='ENOENT')return empty();if(e.code==='ELOOP')throw fail('Research priority store cannot use symbolic links.',403);throw e;}
 finally{await handle?.close();}
}
async function writeStore(base,data){
 if(levels.reduce((total,level)=>total+data.levels[level].length,0)>2000)throw fail('Research priorities support up to 2,000 projects.',413);
 const folder=await directory(base,{create:true}),file=resolve(folder,'.priorities.json'),temp=resolve(folder,'.priorities-'+randomUUID()+'.tmp');
 try{const info=await lstat(file);if(info.isSymbolicLink()||!info.isFile())throw fail('Research priority store must be a regular file.',403);}catch(e){if(e.code!=='ENOENT')throw e;}
 let handle;
 try{handle=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await handle.writeFile(JSON.stringify(data,null,2)+'\n');await handle.close();handle=null;await rename(temp,file);}
 finally{await handle?.close();await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
async function queued(root,operation){
 const base=await realpath(root),previous=queues.get(base)||Promise.resolve();
 const pending=previous.catch(()=>{}).then(()=>operation(base));queues.set(base,pending);
 try{return await pending;}finally{if(queues.get(base)===pending)queues.delete(base);}
}
export async function readResearchPriorities(root){return queued(root,readStore);}
export function applyResearchPriorities(items,store){
 const positions=new Map();for(const priority of levels)store.levels[priority].forEach((path,priorityOrder)=>positions.set(path,{priority,priorityOrder}));
 return items.map(item=>({...item,...positions.get(item.path)||{priority:null,priorityOrder:null}})).sort((a,b)=>{
  const group=(a.priority===null?3:levels.indexOf(a.priority))-(b.priority===null?3:levels.indexOf(b.priority));return group||((a.priorityOrder??0)-(b.priorityOrder??0));
 });
}
async function projects(base){
 const folder=await directory(base),found=new Map();if(!folder)return found;
 for(const entry of await readdir(folder,{withFileTypes:true})){
  if(entry.name.startsWith('.')||!entry.isDirectory()||entry.isSymbolicLink())continue;
  const path='research/'+entry.name+'/README.md';
  try{await safeProject(base,path);found.set(projectId(path),path);}catch(e){if(e.code!=='ENOENT')throw e;}
 }
 return found;
}
function result(store,id,path){
 for(const priority of levels){const priorityOrder=store.levels[priority].indexOf(path);if(priorityOrder!==-1)return{revision:store.revision,id,path,priority,priorityOrder};}
 return{revision:store.revision,id,path,priority:null,priorityOrder:null};
}
function advance(store){if(store.revision===Number.MAX_SAFE_INTEGER)throw fail('Research priority revision is exhausted.',422);return store.revision+1;}
async function readBytes(file){let handle;try{handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);return await handle.readFile();}finally{await handle?.close();}}
async function undoEmptyProject(base,path,bytes){
 // Roll back only the exact scaffold created by this request. Concurrent user content wins.
 const folder=resolve(base,path.slice(0,-10)),file=resolve(base,path);
 try{
  if(!await safeProject(base,path))return;
  const entries=await readdir(folder,{withFileTypes:true});
  if(entries.length!==3||!entries.every(entry=>['README.md','notes','files'].includes(entry.name)&&!entry.isSymbolicLink()&&(entry.name==='README.md'?entry.isFile():entry.isDirectory())))return;
  for(const name of ['notes','files'])if((await readdir(resolve(folder,name))).length)return;
  if(!(await readBytes(file)).equals(bytes))return;
  await unlink(file);
 }catch{return;}
 for(const name of ['notes','files'])await rmdir(resolve(folder,name)).catch(()=>{});
 await rmdir(folder).catch(()=>{});
}
export class ResearchService{
 constructor({workspace,createItem}){this.workspace=workspace;this.createItem=createItem;}
 async update({id,priority,beforeId=null,expectedRevision}={}){
  if(typeof id!=='string'||!/^[a-f0-9]{20}$/.test(id)||!validPriority(priority)||beforeId!==null&&(typeof beforeId!=='string'||!/^[a-f0-9]{20}$/.test(beforeId))||!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw fail('Choose a Research project, priority and current revision.');
  if(priority===null&&beforeId!==null)throw fail('Unassigned projects do not have a manual order.');
  return queued(this.workspace,async base=>{
   const store=await readStore(base);if(store.revision!==expectedRevision)throw fail('Research priorities changed. Refresh and try again.',409);
   const existing=await projects(base),path=existing.get(id);if(!path)throw fail('Research project not found.',404);
   if(beforeId===id){if(result(store,id,path).priority===priority)return result(store,id,path);throw fail('A project cannot be placed before itself in another priority.');}
   const before=beforeId===null?null:existing.get(beforeId);
   if(beforeId!==null&&(!before||!store.levels[priority].includes(before)))throw fail('The destination project must be in the same priority.');
   const next=structuredClone(store);for(const level of levels)next.levels[level]=next.levels[level].filter(value=>value!==path);
   if(priority!==null){const position=before===null?next.levels[priority].length:next.levels[priority].indexOf(before);next.levels[priority].splice(position,0,path);}
   if(JSON.stringify(next.levels)===JSON.stringify(store.levels))return result(store,id,path);
   next.revision=advance(store);await writeStore(base,next);return result(next,id,path);
  });
 }
 async create({title,priority}={}){
  if(!validPriority(priority))throw fail('Choose P1, P2, P3 or an unassigned Research priority.');
  if(typeof this.createItem!=='function')throw new Error('Research project creator is unavailable.');
  return queued(this.workspace,async base=>{
   const store=await readStore(base),revision=advance(store),existing=await projects(base);
   const created=await this.createItem(base,{category:'research',title}),path=projectPath(created.path),id=projectId(path);
   if(existing.has(id))throw fail('Research project already exists.',409);
   const file=await safeProject(base,path),bytes=await readBytes(file),next=structuredClone(store);
   for(const level of levels)next.levels[level]=next.levels[level].filter(value=>value!==path);
   if(priority!==null)next.levels[priority].push(path);next.revision=revision;
   try{await writeStore(base,next);}catch(e){await undoEmptyProject(base,path,bytes);throw e;}
   return result(next,id,path);
  });
 }
}
