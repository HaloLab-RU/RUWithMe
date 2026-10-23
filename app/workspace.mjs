import {readFile,readdir,realpath,stat,lstat,mkdir,writeFile,open,unlink,rename,link} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,relative,sep,extname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {readRecords} from './records.mjs';
import {readCanvasCourseSnapshot} from './courses.mjs';
import {readResearchPriorities,applyResearchPriorities} from './research.mjs';
import {readDemo,readWorkspaceMode,dailyView} from './demo.mjs';
import {sampleWorkspaces} from './sample-workspaces.mjs';
import {sampleInbox} from './sample-inbox.mjs';
import {readFilings} from './materials.mjs';
import {readMaterialProperties} from './material-properties.mjs';
const spaces=['research','courses','learn','career','admin','personal'];
const categories=[...spaces,'inbox'];
const extensions=new Set(['.md','.txt','.tex','.pdf','.html','.htm','.png','.jpg','.jpeg','.webp','.csv','.json','.py','.r','.js']);
export const MAX_SOURCE_BYTES=32*1024*1024;
const error=(message,status=400)=>Object.assign(new Error(message),{status});
const digest=value=>createHash('sha256').update(value).digest('hex');
const inboxMutations=new Map();
async function withInbox(root,operation){
 const base=await realpath(root),previous=inboxMutations.get(base)||Promise.resolve();
 const current=previous.catch(()=>{}).then(()=>operation(base));inboxMutations.set(base,current);
 try{return await current;}finally{if(inboxMutations.get(base)===current)inboxMutations.delete(base);}
}
function validateInboxName(name){
 if(typeof name!=='string'||!name.trim()||name.startsWith('.')||/[\\/\p{Cc}]/u.test(name)||Buffer.byteLength(name)>255)throw error('Choose a visible filename without folders or control characters.');
 if(!extensions.has(extname(name).toLowerCase()))throw error('This file type is not supported yet.',415);
 return name;
}
async function inboxFolder(base){
 const inbox=resolve(base,'inbox');
 if(await realpath(inbox)!==inbox)throw error('Inbox must be a folder inside this workspace.',403);
 return inbox;
}
const validTime=value=>typeof value==='string'&&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString()===value;
async function readInboxMetadata(base){
 const inbox=await inboxFolder(base),file=resolve(inbox,'.metadata.json');let handle;
 try{
  handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  const info=await handle.stat();if(!info.isFile()||info.size>4*1024*1024)throw error('Inbox metadata needs repair. No files were changed.',422);
  const data=JSON.parse(await handle.readFile('utf8'));
  if(data?.version!==1||!data.files||typeof data.files!=='object'||Array.isArray(data.files))throw error('Inbox metadata needs repair. No files were changed.',422);
  const records=Object.create(null);
  for(const [name,record] of Object.entries(data.files)){
   try{validateInboxName(name);}catch{throw error('Inbox metadata needs repair. No files were changed.',422);}
   if(!record||!validTime(record.uploadedAt))throw error('Inbox metadata needs repair. No files were changed.',422);
   records[name]={uploadedAt:record.uploadedAt};
  }
  return{version:1,files:records};
 }catch(e){
  if(e.code==='ENOENT')return{version:1,files:Object.create(null)};
  if(e.code==='ELOOP')throw error('Inbox metadata cannot be a symbolic link.',403);
  if(e instanceof SyntaxError)throw error('Inbox metadata needs repair. No files were changed.',422);
  throw e;
 }finally{if(handle)await handle.close();}
}
async function writeExclusive(file,body){
 let handle;
 try{handle=await open(file,'wx',0o600);await handle.writeFile(body);await handle.close();handle=null;}
 catch(e){
  if(handle){await handle.close().catch(()=>{});await unlink(file).catch(()=>{});}
  if(e.code==='EEXIST')throw error('A file with this name already exists in Inbox. The existing file was kept.',409);
  throw e;
 }
}
async function writeInboxMetadata(base,data){
 const inbox=await inboxFolder(base),file=resolve(inbox,'.metadata.json'),temporary=resolve(inbox,'.metadata.'+randomUUID()+'.tmp');
 try{const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())throw error('Inbox metadata must be a regular file.',403);}catch(e){if(e.code!=='ENOENT')throw e;}
 await writeExclusive(temporary,Buffer.from(JSON.stringify(data,null,2)+'\n'));
 try{await rename(temporary,file);}finally{await unlink(temporary).catch(()=>{});}
}
const validIdeaId=value=>typeof value==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
function ideaText(value){
 if(typeof value!=='string'||!value.trim()||Array.from(value).length>10000)throw error('Enter an idea with 1 to 10,000 characters.');
 return value;
}
async function readInboxIdeas(base){
 const inbox=await inboxFolder(base),file=resolve(inbox,'.ideas.json');let handle;
 const invalid=()=>error('Ideas need repair. Your saved content has not been changed.',422);
 try{
  handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  const info=await handle.stat();if(!info.isFile()||info.size>MAX_SOURCE_BYTES)throw invalid();
  const data=JSON.parse(await handle.readFile('utf8'));
  if(data?.version!==1||!Array.isArray(data.ideas))throw invalid();
  const ids=new Set(),ideas=[];
  for(const idea of data.ideas){
   if(!idea||!validIdeaId(idea.id)||ids.has(idea.id)||!validTime(idea.createdAt)||!validTime(idea.updatedAt)||Date.parse(idea.updatedAt)<Date.parse(idea.createdAt)||!Number.isSafeInteger(idea.revision)||idea.revision<1)throw invalid();
   try{ideaText(idea.text);}catch{throw invalid();}
   ids.add(idea.id);ideas.push({id:idea.id,text:idea.text,createdAt:idea.createdAt,updatedAt:idea.updatedAt,revision:idea.revision});
  }
  return{version:1,ideas};
 }catch(e){
  if(e.code==='ENOENT')return{version:1,ideas:[]};
  if(e.code==='ELOOP')throw error('Ideas cannot be stored in a symbolic link.',403);
  if(e instanceof SyntaxError)throw invalid();
  throw e;
 }finally{if(handle)await handle.close();}
}
async function writeInboxIdeas(base,data){
 const inbox=await inboxFolder(base),file=resolve(inbox,'.ideas.json'),temporary=resolve(inbox,'.ideas.'+randomUUID()+'.tmp'),body=Buffer.from(JSON.stringify(data,null,2)+'\n');
 if(body.length>MAX_SOURCE_BYTES)throw error('Ideas have reached the 32 MB local storage limit.',413);
 try{const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())throw error('Ideas must be stored in a regular file.',403);}catch(e){if(e.code!=='ENOENT')throw e;}
 await writeExclusive(temporary,body);
 try{await rename(temporary,file);}finally{await unlink(temporary).catch(()=>{});}
}
export async function createInboxIdea(root,{text}={}){
 ideaText(text);
 return withInbox(root,async base=>{
  const data=await readInboxIdeas(base),now=new Date().toISOString();
  const idea={id:randomUUID(),text,createdAt:now,updatedAt:now,revision:1};
  data.ideas.push(idea);await writeInboxIdeas(base,data);return idea;
 });
}
export async function updateInboxIdea(root,{id,text,expectedRevision}={}){
 ideaText(text);
 if(!validIdeaId(id)||!Number.isSafeInteger(expectedRevision)||expectedRevision<1)throw error('Choose an idea and provide its current revision.');
 return withInbox(root,async base=>{
  const data=await readInboxIdeas(base),index=data.ideas.findIndex(idea=>idea.id===id);
  if(index<0)throw error('This idea no longer exists.',404);
  const idea=data.ideas[index];
  if(idea.revision!==expectedRevision)throw error('This idea changed elsewhere. Review the latest text before saving again.',409);
  if(idea.text===text)return idea;
  const updated={...idea,text,updatedAt:new Date(Math.max(Date.now(),Date.parse(idea.updatedAt)+1)).toISOString(),revision:idea.revision+1};
  if(!Number.isSafeInteger(updated.revision))throw error('This idea revision cannot be increased.',409);
  data.ideas[index]=updated;await writeInboxIdeas(base,data);return updated;
 });
}
function websiteUrl(value){
 if(typeof value!=='string'||!value.trim()||value.length>4096||/\p{Cc}/u.test(value))throw error('Enter a valid HTTP or HTTPS website URL.');
 let url;try{url=new URL(value.trim());}catch{throw error('Enter a valid HTTP or HTTPS website URL.');}
 if(!['http:','https:'].includes(url.protocol)||!url.hostname||url.username||url.password)throw error('Use an HTTP or HTTPS URL without a username or password.');
 return url;
}
function linkTitle(value,fallback){
 if(value!==undefined&&typeof value!=='string')throw error('Enter a link title up to 200 characters.');
 const title=value?.trim()||fallback;
 if(!title||Array.from(title).length>200||/\p{Cc}/u.test(title))throw error('Enter a link title up to 200 characters.');
 return title;
}
function linkRecord(body){
 try{
  const data=JSON.parse(body);
  if(data?.type!=='ruwithme-link'||data.version!==1||!validTime(data.addedAt)||typeof data.title!=='string'||!data.title.trim())return null;
  return{type:'ruwithme-link',version:1,title:linkTitle(data.title),url:websiteUrl(data.url).href,addedAt:data.addedAt};
 }catch{return null;}
}
function linkFilename(title){
 const cleaned=title.replace(/[^\p{L}\p{N}\p{M} ._-]/gu,'-').replace(/^\.+/,'').trim()||'Website';
 let stem='';for(const character of cleaned){if(Buffer.byteLength(stem+character)>235)break;stem+=character;}
 return(stem.trim()||'Website')+'.link.json';
}
async function sourceInfo(root,path){
 if(typeof path!=='string'||path.includes('\\')||path.includes('\0')||path.split('/').some(p=>!p||p==='.'||p==='..'||p.startsWith('.'))||!categories.includes(path.split('/')[0])||!extensions.has(extname(path).toLowerCase()))throw error('This source path is not available.',403);
 const base=await realpath(root),file=await realpath(resolve(base,path)),rel=relative(base,file);
 if(rel.startsWith('..'+sep)||rel==='..'||!categories.includes(rel.split(sep)[0])||rel.split(sep).some(p=>p.startsWith('.')))throw error('The file is outside this workspace.',403);
 const info=await stat(file);if(!info.isFile())throw error('This source is not a regular file.',403);
 return{file,info,path};
}
export async function safeFile(root,path){
 const source=await sourceInfo(root,path);
 if(source.info.size>MAX_SOURCE_BYTES)throw error('Preview supports files up to 32 MB.',413);
 return source;
}
export async function uploadInboxFile(root,name,body){
 validateInboxName(name);
 if(!Buffer.isBuffer(body))throw error('A binary file is required.');
 if(body.length>MAX_SOURCE_BYTES)throw error('Upload supports files up to 32 MB.',413);
 return withInbox(root,async base=>{
  const inbox=await inboxFolder(base),metadata=await readInboxMetadata(base),file=resolve(inbox,name),uploadedAt=new Date().toISOString();
  await writeExclusive(file,body);metadata.files[name]={uploadedAt};
  try{await writeInboxMetadata(base,metadata);}catch(e){await unlink(file).catch(()=>{});throw e;}
  return{path:'inbox/'+name,name,size:body.length,kind:'file',uploadedAt};
 });
}
export async function createInboxLink(root,{url,title}={}){
 const parsed=websiteUrl(url),label=linkTitle(title,parsed.hostname),name=linkFilename(label);
 return withInbox(root,async base=>{
  const inbox=await inboxFolder(base),metadata=await readInboxMetadata(base),addedAt=new Date().toISOString(),file=resolve(inbox,name);
  const record={type:'ruwithme-link',version:1,title:label,url:parsed.href,addedAt};
  await writeExclusive(file,Buffer.from(JSON.stringify(record,null,2)+'\n'));delete metadata.files[name];
  try{await writeInboxMetadata(base,metadata);}catch(e){await unlink(file).catch(()=>{});throw e;}
  return{path:'inbox/'+name,name,kind:'link',title:label,url:parsed.href,addedAt,uploadedAt:null};
 });
}
export async function renameInboxFile(root,{path,name}={}){
 if(typeof path!=='string'||!path.startsWith('inbox/'))throw error('Choose a file directly inside Inbox.');
 const original=validateInboxName(path.slice(6));validateInboxName(name);
 if(extname(original).toLowerCase()!==extname(name).toLowerCase())throw error('Keep the original file extension when renaming.');
 return withInbox(root,async base=>{
  const inbox=await inboxFolder(base),source=resolve(inbox,original),destination=resolve(inbox,name),info=await lstat(source);
  if(!info.isFile()||info.isSymbolicLink())throw error('Only regular files directly inside Inbox can be renamed.',403);
  const metadata=await readInboxMetadata(base),uploadedAt=metadata.files[original]?.uploadedAt||null;
  const record=/\.link\.json$/i.test(original)&&info.size<=16000?linkRecord(await readFile(source,'utf8')):null;
  if(record&&!/\.link\.json$/i.test(name))throw error('Keep the .link.json suffix for a website link.');
  const result={path:'inbox/'+name,name,kind:record?'link':'file',uploadedAt};
  if(record)Object.assign(result,{title:record.title,url:record.url,addedAt:record.addedAt});
  if(name===original)return result;
  if(name.toLowerCase()===original.toLowerCase())throw error('A case-only rename is not supported. Choose a different name first.',409);
  if(record){result.title=linkTitle(name.slice(0,-10));await writeExclusive(destination,Buffer.from(JSON.stringify({...record,title:result.title},null,2)+'\n'));}
  else{try{await link(source,destination);}catch(e){if(e.code==='EEXIST')throw error('A file with this name already exists in Inbox. The existing file was kept.',409);throw e;}}
  const next={version:1,files:Object.assign(Object.create(null),metadata.files)};delete next.files[original];delete next.files[name];
  if(uploadedAt)next.files[name]={uploadedAt};
  let saved=false;
  try{await writeInboxMetadata(base,next);saved=true;await unlink(source);}
  catch(e){
   if(saved)await writeInboxMetadata(base,metadata);
   await unlink(destination).catch(()=>{});throw e;
  }
  return result;
 });
}
export function metadata(source){
 source=source.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n');
 const data={};if(!source.startsWith('---\n'))return data;const end=source.indexOf('\n---',4);if(end<0)throw error('A README has unfinished frontmatter. Please finish it before refreshing.',422);
 for(const line of source.slice(4,end).split('\n')){if(!line.trim()||line.trim().startsWith('#'))continue;const match=line.match(/^([\w-]+):\s*(.*)$/);if(!match)continue;let value=match[2];if(value.startsWith('"')){try{value=JSON.parse(value);}catch{value=value.replace(/^"|"$/g,'');}}else if(value.startsWith("'"))value=value.replace(/^'|'$/g,'').replace(/''/g,"'");data[match[1]]=value==='null'?'':value;}
 return data;
}
async function files(root,folder){
 const result=[];for(const entry of await readdir(resolve(root,folder),{withFileTypes:true})){
  if(entry.name.startsWith('.')||entry.isSymbolicLink())continue;const path=folder+'/'+entry.name;
  if(entry.isDirectory())result.push(...await files(root,path));
  else if(entry.isFile()&&extensions.has(extname(path).toLowerCase())){const {info}=await sourceInfo(root,path);result.push({path,name:entry.name,size:info.size,modified:info.mtimeMs,kind:'file',uploadedAt:null,previewAvailable:info.size<=MAX_SOURCE_BYTES});}
 }return result.sort((a,b)=>a.path.localeCompare(b.path));
}
export async function indexWorkspace(root){
 let ideas=[];
 const all=(await Promise.all(categories.map(c=>c==='inbox'?withInbox(root,async base=>{
  const metadata=await readInboxMetadata(base);ideas=(await readInboxIdeas(base)).ideas;
  const entries=await files(base,'inbox');
  for(const entry of entries){
   if(entry.path==='inbox/'+entry.name)entry.uploadedAt=metadata.files[entry.name]?.uploadedAt||null;
   if(/\.link\.json$/i.test(entry.name)&&entry.size<=16000){
    const record=linkRecord(await readFile((await safeFile(base,entry.path)).file,'utf8'));
    if(record)Object.assign(entry,{kind:'link',title:record.title,url:record.url,addedAt:record.addedAt});
   }
  }
  return entries;
 }):scanSpace(root,c)))).flat(),items=Object.fromEntries(spaces.map(c=>[c,[]]));
 const materials=await readMaterialProperties(root),propertiesByPath=new Map(materials.items.map(row=>[row.path,row]));
 for(const file of all)if(propertiesByPath.has(file.path))file.materialProperties=propertiesByPath.get(file.path);
 for(const source of all){const match=source.path.match(/^(research|learn|career|admin|personal)\/[^/]+\/README\.md$/)||source.path.match(/^(courses)\/[^/]+\/[^/]+\/README\.md$/);if(!match||!source.previewAvailable)continue;
  const body=await readFile((await safeFile(root,source.path)).file,'utf8'),meta=metadata(body),folder=source.path.slice(0,-10),parts=folder.split('/');
  const course=match[1]==='courses',canvas=course?await readCanvasCourseSnapshot(root,folder):null;
  const item={id:digest(canvas?'canvas:'+canvas.courseId+':'+canvas.role:source.path).slice(0,20),path:source.path,folder,title:meta.title||body.match(/^#\s+(.+)$/m)?.[1]||parts.at(-1),notes:body.replace(/^\uFEFF/,'').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,'').replace(/^\s*# [^\r\n]+(?:\r?\n|$)/,'').trim(),summary:meta.summary||'',next:meta.next||'',status:meta.status||'',exampleWorkspace:/^>\s*Synthetic example - not a record of your work\./m.test(body),currentUnderstanding:meta.current_understanding||'',openQuestions:meta.open_questions||'',contextSession:meta.context_session?{id:meta.context_session,revision:Number(meta.context_session_revision),date:meta.context_session_date||'',fields:(meta.context_fields||'').split(',')}:null,semester:course?meta.semester||canvas?.term||parts[1]:'',files:all.filter(f=>f.path.startsWith(folder+'/')&&f.path!==source.path)};
  if(course){item.courseRole=['student','ta'].includes(meta.course_role)?meta.course_role:canvas?.role||'unclassified';item.historicalExample=['true','false'].includes(meta.historical_example)?meta.historical_example==='true':canvas?.historicalExample||false;item.canvas=canvas;}
  items[match[1]].push(item);
 }
 let inbox=all.filter(f=>f.path.startsWith('inbox/'));const filings=await readFilings(root);
 for(const entry of inbox)entry.filedTo=filings.items.filter(row=>row.sourcePath===entry.path);
 const mode=await readWorkspaceMode(root),rawRecords=await readRecords(root),records=dailyView(rawRecords,mode);
 const priorities=await readResearchPriorities(root),research={version:1,revision:priorities.revision};
 items.research=applyResearchPriorities(items.research,priorities);
 const workspaceSamples=await sampleWorkspaces(root,items,rawRecords,{materials,filings,priorities}),hiddenProjects=new Set(workspaceSamples.filter(row=>row.eligible&&mode?.archived.workspaces?.includes(row.id)).map(row=>row.id));
 for(const space of spaces)items[space]=items[space].filter(row=>!hiddenProjects.has(row.id));
 const inboxSamples=await sampleInbox(root,inbox,ideas,{records:rawRecords,filings});
 const hiddenInbox=new Set(inboxSamples.filter(row=>row.eligible&&mode?.archived[row.kind==='file'?'inboxFiles':'inboxIdeas']?.includes(row.id)).map(row=>row.kind==='file'?row.path:row.id));
 inbox=inbox.filter(row=>!hiddenInbox.has(row.path));ideas=ideas.filter(row=>!hiddenInbox.has(row.id));
 const demo=await readDemo(root);
 return{sampleInbox:inboxSamples,sampleWorkspaces:workspaceSamples,version:1,name:'ruwithme',items,inbox,ideas,records,research,demo,mode,counts:{...Object.fromEntries(spaces.map(c=>[c,items[c].length])),inbox:inbox.length+ideas.length},revision:digest(JSON.stringify({all,items,ideas,records,research,filings,demo,mode,materials,workspaceSamples,inboxSamples})),checkedAt:new Date().toISOString()};
}
async function scanSpace(root,category){
 const base=await realpath(root),folder=resolve(base,category);let actual;
 try{actual=await realpath(folder);}catch(e){if(e.code==='ENOENT'&&['career','admin','personal'].includes(category))return[];throw e;}
 if(actual!==folder)throw error('Content spaces cannot use symbolic links.',403);
 return files(base,category);
}
function slug(value){return value.normalize('NFKC').trim().replace(/[^\p{L}\p{N}_ -]/gu,'').replace(/\s+/g,'-').slice(0,100);}
export async function createItem(root,{category,title,semester='',courseRole='unclassified'}){
 if(!spaces.includes(category)||typeof title!=='string'||!title.trim()||title.length>120||/[\r\n]/.test(title))throw error('Choose a category and enter a name up to 120 characters.');
 const name=slug(title);if(!name)throw error('Use a name containing letters or numbers.');
 let parent=category;
 if(category==='courses'){if(typeof semester!=='string'||!semester.trim()||semester.length>80||!slug(semester))throw error('Enter the course semester.');if(!['student','ta','unclassified'].includes(courseRole))throw error('Choose a student or TA course role.');parent+='/'+slug(semester);}
 const base=await realpath(root);
 await mkdir(resolve(base,category),{recursive:true});
 if(await realpath(resolve(base,category))!==resolve(base,category))throw error('Choose a folder inside this workspace.',403);
 await mkdir(resolve(base,parent),{recursive:true});
 const realParent=await realpath(resolve(base,parent));if(realParent!==resolve(base,parent))throw error('Choose a folder inside this workspace.',403);
 const folder=parent+'/'+name;
 try{await mkdir(resolve(base,folder));}catch(e){if(e.code==='EEXIST')throw error('That workspace already exists. Choose another name.',409);throw e;}
 await mkdir(resolve(base,folder,'notes'));await mkdir(resolve(base,folder,'files'));
 await writeFile(resolve(base,folder,'README.md'),'---\ntitle: '+JSON.stringify(title.trim())+'\nsummary: ""\nstatus: ""\nnext: ""\n'+(category==='courses'?'course_role: '+JSON.stringify(courseRole)+'\n':'')+'---\n\n# '+title.trim()+'\n',{flag:'wx'});
 return{path:folder+'/README.md'};
}
