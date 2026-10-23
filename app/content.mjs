import {open,lstat,realpath,mkdir,rename,unlink,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,dirname,extname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {metadata} from './workspace.mjs';

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const hash=content=>createHash('sha256').update(content).digest('hex');
const limit=256*1024,queues=new Map();
const canonical=path=>/^(?:(?:research|learn|career|admin|personal)\/[^/]+|courses\/[^/]+\/[^/]+)\/README\.md$/.test(path);
function validatePath(path){
 if(typeof path!=='string'||path.includes('\\')||path.split('/').some(part=>!part||part==='.'||part==='..'||part.startsWith('.')||/\p{Cc}/u.test(part))||!['.md','.txt','.tex'].includes(extname(path).toLowerCase())||!/^(?:(?:research|learn|career|admin|personal)\/[^/]+|courses\/[^/]+\/[^/]+)\//.test(path))throw fail('Choose a local Markdown, text or TeX note inside a workspace.',403);
}
async function source(root,path){
 validatePath(path);const base=await realpath(root),parts=path.split('/');
 for(let index=1;index<parts.length;index++){
  const folder=resolve(base,...parts.slice(0,index)),info=await lstat(folder);
  if(!info.isDirectory()||info.isSymbolicLink()||await realpath(folder)!==folder)throw fail('Workspace folders must not be symbolic links.',403);
 }
 const file=resolve(base,path);let handle;
 try{
  handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);const info=await handle.stat();
  if(!info.isFile()||info.size>limit)throw fail('The editor supports local text notes up to 256 KiB.',413);
  const bytes=await handle.readFile();if(bytes.length>limit)throw fail('The editor supports local text notes up to 256 KiB.',413);let content;
  try{content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw fail('This note is not UTF-8 text. The original has been kept.',415);}
  if(content.includes('\0'))throw fail('This note is not plain text.',415);
  return{file,info,bytes,content,revision:hash(bytes)};
 }catch(error){if(error.code==='ELOOP')throw fail('Notes must not be symbolic links.',403);throw error;}
 finally{await handle?.close();}
}
function splitNote(content){
 const prefix=content.startsWith('\uFEFF')?'\uFEFF':'';if(prefix)content=content.slice(1);
 const match=content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
 if(content.startsWith('---\n')||content.startsWith('---\r\n')){if(!match)throw fail('Finish the workspace note frontmatter before editing.',422);}
 return{prefix,header:match?.[1]||'',notes:match?content.slice(match[0].length):content,eol:content.includes('\r\n')?'\r\n':'\n'};
}
function view(path,data){
 const result={path,revision:data.revision,content:data.content};
 if(canonical(path)){
  const {notes}=splitNote(data.content),meta=metadata(data.content.replace(/\r\n/g,'\n'));
  result.fields={title:meta.title||notes.match(/^#\s+(.+)$/m)?.[1]||path.split('/').at(-2),summary:meta.summary||'',status:meta.status||'',next:meta.next||'',currentUnderstanding:meta.current_understanding||'',openQuestions:meta.open_questions||'',notes};
  if(meta.context_session)result.contextSource={id:meta.context_session,revision:Number(meta.context_session_revision),date:meta.context_session_date||'',fields:(meta.context_fields||'').split(',')};
  if(path.startsWith('courses/')){result.fields.courseRole=meta.course_role||'unclassified';result.fields.semester=meta.semester||path.split('/')[1];}
 }
 return result;
}
export async function readContent(root,path){return view(path,await source(root,path));}
function fieldsContent(path,original,fields,contextSource){
 if(!fields||typeof fields!=='object'||Array.isArray(fields))throw fail('Provide the workspace fields to save.');
 const limits={title:200,summary:10000,status:120,next:10000,currentUnderstanding:10000,openQuestions:10000,notes:limit},current=view(path,{content:original,revision:''}).fields;
 fields={...fields,currentUnderstanding:fields.currentUnderstanding??current.currentUnderstanding,openQuestions:fields.openQuestions??current.openQuestions};
 for(const [key,max] of Object.entries(limits))if(typeof fields[key]!=='string'||fields[key].length>max||fields[key].includes('\0')||(key==='title'||key==='status')&&/[\r\n]/.test(fields[key]))throw fail('Check the '+key+' field and its length.');
 if(!fields.title.trim())throw fail('Enter a workspace name.');
 if(path.startsWith('courses/')&&!['student','ta','unclassified'].includes(fields.courseRole))throw fail('Choose Student, TA or an unconfirmed course role.');
 if(path.startsWith('courses/')&&(typeof fields.semester!=='string'||!fields.semester.trim()||fields.semester.length>80||/[\r\n\0]/.test(fields.semester)))throw fail('Enter a semester up to 80 characters.');
 if(!contextSource&&Object.keys(current).every(key=>current[key]===fields[key]))return original;
 const {prefix,header,eol}=splitNote(original);let updated=header;
 const values={title:fields.title.trim(),summary:fields.summary,status:fields.status,next:fields.next,current_understanding:fields.currentUnderstanding,open_questions:fields.openQuestions,...(contextSource?{context_session:contextSource.id,context_session_revision:String(contextSource.revision),context_session_date:contextSource.date,context_fields:(contextSource.fields||[]).join(',')}:{}),...(path.startsWith('courses/')?{course_role:fields.courseRole,semester:fields.semester.trim()}:{})};
 for(const [key,value] of Object.entries(values)){
  const expression=new RegExp('^'+key+':[^\\r\\n]*','gm'),matches=[...updated.matchAll(expression)];
  if(matches.length>1||matches.some(match=>/[:]\s*[|>]/.test(match[0])))throw fail('The '+key+' frontmatter needs a plain scalar value before using this editor. Your file has not changed.',422);
  const line=key+': '+JSON.stringify(value);
  updated=matches.length?updated.replace(expression,()=>line):updated+(updated?eol:'')+line;
 }
 let notes=fields.notes;
 if(fields.title!==current.title&&notes===current.notes)notes=notes.replace(/^# ([^\r\n]+)$/m,(line,title)=>title===current.title?'# '+fields.title.trim():line);
 return prefix+'---'+eol+updated+eol+'---'+eol+notes;
}
export async function saveContent(root,input={},options={}){
 const {path,expectedRevision}=input;validatePath(path);
 if(typeof expectedRevision!=='string'||!/^[a-f0-9]{64}$/.test(expectedRevision))throw fail('Read the current note before saving.');
 const base=await realpath(root),key=base+'/'+path,previous=queues.get(key)||Promise.resolve();
 const operation=previous.catch(()=>{}).then(async()=>{
  const original=await source(base,path);
  if(original.revision!==expectedRevision)throw fail('This note changed elsewhere. Review the latest version before saving your draft.',409);
  let content;
  if(canonical(path))content=fieldsContent(path,original.content,input.fields,options.contextSource);
  else{content=input.content;if(typeof content!=='string'||content.includes('\0'))throw fail('Provide the note text.');}
  const bytes=Buffer.from(content);
  if(bytes.length>limit)throw fail('The editor supports notes up to 256 KiB.',413);
  if(bytes.equals(original.bytes))return view(path,original);
  const history=resolve(dirname(original.file),'.edit-history');
  await mkdir(history,{recursive:true});const historyInfo=await lstat(history);
  if(!historyInfo.isDirectory()||historyInfo.isSymbolicLink()||await realpath(history)!==history)throw fail('Note history must remain inside this workspace.',403);
  const backup=resolve(history,hash(path)+'.'+original.revision);
  try{await writeFile(backup,original.bytes,{flag:'wx',mode:0o600});}catch(error){
   if(error.code!=='EEXIST')throw error;let handle;
   try{handle=await open(backup,constants.O_RDONLY|constants.O_NOFOLLOW);const info=await handle.stat();if(!info.isFile()||info.size!==original.bytes.length||!(await handle.readFile()).equals(original.bytes))throw fail('The existing note history needs review. Your current file has not changed.',422);}
   finally{await handle?.close();}
  }
  const temporary=resolve(dirname(original.file),'.edit-'+randomUUID()+'.tmp');
  try{
   await writeFile(temporary,bytes,{flag:'wx',mode:original.info.mode&0o777});
   const latest=await source(base,path);
   if(latest.revision!==expectedRevision)throw fail('This note changed during the save. Your draft has not replaced it.',409);
   await rename(temporary,original.file);
  }finally{await unlink(temporary).catch(()=>{});}
  return view(path,{content,revision:hash(bytes)});
 });
 queues.set(key,operation);try{return await operation;}finally{if(queues.get(key)===operation)queues.delete(key);}
}

export async function handleContentRequest(req,res,{workspace,daily,origin,json}){
 const url=new URL(req.url,origin);if(!['/api/content','/api/content/save'].includes(url.pathname))return false;
 if(url.pathname==='/api/content'){
  if(req.method!=='GET'){json(res,405,{error:'Method not allowed'});return true;}
  json(res,200,await readContent(workspace,url.searchParams.get('path')));return true;
 }
 if(req.method!=='POST'){json(res,405,{error:'Method not allowed'});return true;}
 if(req.headers.origin!==origin||req.headers['x-ruwithme-csrf']!==daily.csrf){json(res,403,{error:'Refresh the page before saving a workspace note.'});return true;}
 if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json'){json(res,415,{error:'JSON required'});return true;}
 const max=2*limit;if(Number(req.headers['content-length'])>max){req.resume();json(res,413,{error:'Request too large'});return true;}
 let size=0;const chunks=[];
 for await(const chunk of req.iterator({destroyOnReturn:false})){size+=chunk.length;if(size>max){req.resume();json(res,413,{error:'Request too large'});return true;}chunks.push(chunk);}
 const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 if(!input||typeof input!=='object'||Array.isArray(input))throw fail('A JSON object is required.');
 json(res,200,await saveContent(workspace,input));return true;
}
