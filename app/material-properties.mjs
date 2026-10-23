import {open,lstat,realpath,mkdir,rmdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,extname} from 'node:path';
import {writePrivateJSON} from './google-calendar.mjs';

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const STORE='.material-properties.json',MAX_BYTES=4*1024*1024;
const extensions=new Set(['.md','.txt','.tex','.pdf','.html','.htm','.png','.jpg','.jpeg','.webp','.csv','.json','.py','.r','.js']);
const priorities=['','high','medium','low'];
const empty=()=>({version:1,revision:0,items:[]});
function materialPath(path){
 if(typeof path!=='string'||path.length>4000||/[\\\p{Cc}]/u.test(path))throw fail('Choose a file attached to a workspace.');
 const parts=path.split('/'),depth=parts[0]==='courses'?3:2;
 if(!['research','courses','learn','career','admin','personal'].includes(parts[0])||parts.length<=depth||parts.some(part=>!part||part.startsWith('.'))||!extensions.has(extname(path).toLowerCase())||parts.length===depth+1&&parts.at(-1)==='README.md')throw fail('Choose an attached note or file, rather than the workspace overview.');
 return parts;
}
function fields({summary,priority,properties}={}){
 if(typeof summary!=='string'||summary.length>600||!priorities.includes(priority)||!Array.isArray(properties)||properties.length>8)throw fail('Use a short summary up to 600 characters, a priority, and up to 8 custom properties.');
 const seen=new Set(),clean=[];
 for(const row of properties){
  if(!row||typeof row.name!=='string'||!row.name.trim()||row.name.length>40||/[\p{Cc}]/u.test(row.name)||typeof row.value!=='string'||!row.value.trim()||row.value.length>200)throw fail('Each custom property needs a name (up to 40 characters) and a value (up to 200).');
  const name=row.name.trim(),key=name.toLowerCase();if(seen.has(key)||['summary','short summary','priority'].includes(key))throw fail('Use a distinct name for each custom property.');seen.add(key);clean.push({name,value:row.value.trim()});
 }
 return{summary:summary.trim(),priority,properties:clean};
}
async function safeMaterial(base,path){
 const parts=materialPath(path);
 try{for(let i=1;i<=parts.length;i++){
  const file=resolve(base,...parts.slice(0,i)),info=await lstat(file);
  if(info.isSymbolicLink()||(i===parts.length?!info.isFile():!info.isDirectory())||await realpath(file)!==file)throw fail('Material properties cannot follow symbolic links.',403);
 }}catch(error){if(error.code==='ENOENT')throw fail('This material no longer exists. Refresh the workspace.',404);throw error;}
}
export async function readMaterialProperties(root){
 const base=await realpath(root);let handle;
 try{
  handle=await open(resolve(base,STORE),constants.O_RDONLY|constants.O_NOFOLLOW);const info=await handle.stat();if(!info.isFile()||info.size>MAX_BYTES)throw fail('Material properties need repair. Saved data was kept.',422);
  const data=JSON.parse(await handle.readFile('utf8'));
  if(data?.version!==1||!Number.isSafeInteger(data.revision)||data.revision<0||!Array.isArray(data.items)||data.items.length>10000)throw fail('Material properties have an unsupported format.',422);
  const seen=new Set();for(const row of data.items){
   try{materialPath(row?.path);fields(row);}catch{throw fail('Material properties need repair. Saved data was kept.',422);}
   if(seen.has(row.path)||!Number.isSafeInteger(row.revision)||row.revision<1||typeof row.updatedAt!=='string'||!Number.isFinite(Date.parse(row.updatedAt)))throw fail('Material properties need repair. Saved data was kept.',422);seen.add(row.path);
  }
  return data;
 }catch(error){if(error.code==='ENOENT')return empty();if(error.code==='ELOOP')throw fail('Material properties cannot be a symbolic link.',403);if(error instanceof SyntaxError)throw fail('Material properties need repair. Saved data was kept.',422);throw error;}
 finally{await handle?.close();}
}
export async function getMaterialProperties(root,path){
 const base=await realpath(root);await safeMaterial(base,path);const store=await readMaterialProperties(base);
 return store.items.find(row=>row.path===path)||{path,revision:0,summary:'',priority:'',properties:[]};
}
export async function saveMaterialProperties(root,input={}){
 const {path,expectedRevision}=input,values=fields(input);materialPath(path);
 if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw fail('Provide the current material properties revision.');
 const base=await realpath(root),lock=resolve(base,'.material-properties.lock');
 try{await mkdir(lock,{mode:0o700});}catch(error){if(error.code==='EEXIST')throw fail('Material properties are being saved elsewhere. Try again shortly.',409);throw error;}
 try{
  await safeMaterial(base,path);const store=await readMaterialProperties(base),index=store.items.findIndex(row=>row.path===path),saved=store.items[index];
  if((saved?.revision||0)!==expectedRevision)throw fail('These properties changed elsewhere. Review the latest version; your draft is preserved.',409);
  if(saved&&JSON.stringify(fields(saved))===JSON.stringify(values))return saved;
  if((saved?.revision||0)===Number.MAX_SAFE_INTEGER||store.revision===Number.MAX_SAFE_INTEGER)throw fail('The properties revision limit was reached.',422);
  if(index<0&&store.items.length>=10000)throw fail('Material properties have reached their storage limit.',413);
  const row={...saved,path,...values,revision:(saved?.revision||0)+1,updatedAt:new Date().toISOString()};
  if(index<0)store.items.push(row);else store.items[index]=row;store.revision++;
  if(Buffer.byteLength(JSON.stringify(store))>MAX_BYTES)throw fail('Material properties have reached their storage limit.',413);
  await writePrivateJSON(resolve(base,STORE),store);return row;
 }finally{await rmdir(lock);}
}
