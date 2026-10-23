import {open,lstat,realpath,mkdir,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,extname} from 'node:path';
import {writePrivateJSON} from './google-calendar.mjs';
import {getMaterialProperties,saveMaterialProperties} from './material-properties.mjs';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const extensions=new Set(['.md','.txt','.tex','.pdf','.html','.htm','.png','.jpg','.jpeg','.webp','.csv','.json','.py','.r','.js']);
const queues=new Map(),maxBytes=32*1024*1024;
function nameOK(name){if(typeof name!=='string'||!name.trim()||name.startsWith('.')||/[\\/\p{Cc}]/u.test(name)||Buffer.byteLength(name)>255||!extensions.has(extname(name).toLowerCase()))throw fail('Choose a supported filename without folders or control characters.');}
async function directory(path){const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path)throw fail('Materials must remain inside real workspace folders.',403);}
async function target(root,ownerPath,folder='files'){
 if(typeof ownerPath!=='string'||! /^(?:(?:research|learn|career|admin|personal)\/[^/]+|courses\/[^/]+\/[^/]+)\/README\.md$/.test(ownerPath)||ownerPath.split('/').some(part=>part.startsWith('.')||/[\\\p{Cc}]/u.test(part))||!['files','notes'].includes(folder))throw fail('Choose an existing workspace and a notes/files folder.',403);
 const base=await realpath(root),parts=ownerPath.split('/').slice(0,-1);for(let i=1;i<=parts.length;i++)await directory(resolve(base,...parts.slice(0,i)));
 const note=await lstat(resolve(base,ownerPath));if(!note.isFile()||note.isSymbolicLink())throw fail('The workspace note is unavailable.',403);
 const destination=resolve(base,...parts,folder);await mkdir(destination,{recursive:true});await directory(destination);return{base,destination,prefix:parts.join('/')+'/'+folder};
}
async function serial(root,operation){const key=await realpath(root),previous=queues.get(key)||Promise.resolve(),current=previous.catch(()=>{}).then(()=>operation(key));queues.set(key,current);try{return await current;}finally{if(queues.get(key)===current)queues.delete(key);}}
async function exclusive(file,body){let handle;try{handle=await open(file,'wx',0o600);await handle.writeFile(body);}catch(error){if(handle)await unlink(file).catch(()=>{});if(error.code==='EEXIST')throw fail('That filename already exists in the destination. The existing file was kept.',409);throw error;}finally{await handle?.close();}}
export async function readFilings(root){
 const base=await realpath(root);await directory(resolve(base,'inbox'));let handle;
 try{handle=await open(resolve(base,'inbox/.filings.json'),constants.O_RDONLY|constants.O_NOFOLLOW);const info=await handle.stat();if(!info.isFile()||info.size>1024*1024)throw fail('Inbox filing receipts need review.',422);const data=JSON.parse(await handle.readFile('utf8'));if(data?.version!==1||!Array.isArray(data.items)||data.items.some(row=>typeof row?.sourcePath!=='string'||!row.sourcePath.startsWith('inbox/')||typeof row.path!=='string'||typeof row.ownerPath!=='string'))throw fail('Inbox filing receipts need review.',422);return data;}
 catch(error){if(error.code==='ENOENT')return{version:1,items:[]};if(error.code==='ELOOP')throw fail('Inbox filing receipts cannot be a symbolic link.',403);throw error;}
 finally{await handle?.close();}
}
export async function uploadMaterial(root,{ownerPath,folder='files',name,body}){
 nameOK(name);if(!Buffer.isBuffer(body)||body.length>maxBytes)throw fail('Upload supports original files up to 32 MiB.',413);
 return serial(root,async()=>{const destination=await target(root,ownerPath,folder);await exclusive(resolve(destination.destination,name),body);return{path:destination.prefix+'/'+name,name,size:body.length};});
}
export async function fileInboxCopy(root,{path,ownerPath,folder='files',expectedSize,expectedModified}={}){
 if(typeof path!=='string'||!path.startsWith('inbox/')||path.split('/').length!==2)throw fail('Choose an original Inbox file.');const name=path.slice(6);nameOK(name);
 return serial(root,async base=>{
  await directory(resolve(base,'inbox'));const destination=await target(base,ownerPath,folder);let handle;
  try{handle=await open(resolve(base,path),constants.O_RDONLY|constants.O_NOFOLLOW);const info=await handle.stat();if(!info.isFile()||info.size>maxBytes)throw fail('This Inbox source is unavailable.',413);if(info.size!==expectedSize||info.mtimeMs!==expectedModified)throw fail('The Inbox file changed. Refresh and review before filing it.',409);
   const body=await handle.readFile(),after=await handle.stat();if(after.size!==info.size||after.mtimeMs!==info.mtimeMs)throw fail('The Inbox file changed while it was being read. Refresh before filing.',409);if(body.length>maxBytes)throw fail('This Inbox source is too large.',413);const result={sourcePath:path,path:destination.prefix+'/'+name,ownerPath,filedAt:new Date().toISOString()};const receipts=await readFilings(base);
   if(receipts.items.some(row=>row.sourcePath===path&&row.path===result.path))throw fail('This destination already has a filing receipt. Open the filed copy or choose another destination.',409);
   await exclusive(resolve(destination.destination,name),body);try{receipts.items.push(result);await writePrivateJSON(resolve(base,'inbox/.filings.json'),receipts);}catch(error){await unlink(resolve(destination.destination,name)).catch(()=>{});throw error;}return result;
  }catch(error){if(error.code==='ELOOP')throw fail('Inbox source files cannot be symbolic links.',403);throw error;}finally{await handle?.close();}
 });
}
export async function handleMaterialRequest(req,res,{workspace,daily,origin,json}){
 const url=new URL(req.url,origin);if(!['/api/materials/upload','/api/materials/file-inbox','/api/materials/properties','/api/materials/properties/save'].includes(url.pathname))return false;
 if(url.pathname==='/api/materials/properties'){
  if(req.method!=='GET'){json(res,405,{error:'Method not allowed'});return true;}
  json(res,200,await getMaterialProperties(workspace,url.searchParams.get('path')));return true;
 }
 if(req.method!=='POST'){json(res,405,{error:'Method not allowed'});return true;}
 if(req.headers.origin!==origin||req.headers['x-ruwithme-csrf']!==daily.csrf){json(res,403,{error:'Refresh before changing materials.'});return true;}
 const upload=url.pathname.endsWith('/upload'),required=upload?'application/octet-stream':'application/json',limit=upload?maxBytes:16000;
 if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!==required){json(res,415,{error:required+' required'});return true;}
 if(Number(req.headers['content-length'])>limit){req.resume();json(res,413,{error:'Request too large'});return true;}
 let size=0;const chunks=[];for await(const chunk of req.iterator({destroyOnReturn:false})){size+=chunk.length;if(size>limit){req.resume();json(res,413,{error:'Request too large'});return true;}chunks.push(chunk);}const body=Buffer.concat(chunks);
 let input;if(!upload){input=JSON.parse(body.toString('utf8'));if(!input||typeof input!=='object'||Array.isArray(input))throw fail('A JSON object is required.');}
 const properties=url.pathname.endsWith('/properties/save');
 const result=upload?await uploadMaterial(workspace,{ownerPath:url.searchParams.get('ownerPath'),folder:url.searchParams.get('folder')||'files',name:url.searchParams.get('name'),body}):properties?await saveMaterialProperties(workspace,input):await fileInboxCopy(workspace,input);json(res,properties?200:201,result);return true;
}
