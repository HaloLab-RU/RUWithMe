import {readdir,realpath,lstat,open,mkdir,writeFile,rename,unlink,rmdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const importQueues=new Map(),roles=new Set(['student','ta']),maxSnapshotBytes=4*1024*1024;
function text(value,label,limit,{optional=false,preserve=false}={}){
 if(optional&&value===undefined)return'';
 if(typeof value!=='string'||(!optional&&!value.trim())||Array.from(value).length>limit||value.includes('\0'))throw fail('Provide '+label+' with up to '+limit+' characters.');
 return preserve?value:value.trim();
}
function instant(value,label){
 if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)||Number.isNaN(Date.parse(value)))throw fail('Provide an ISO timestamp with an explicit timezone for '+label+'.');
 dateOnly(value.slice(0,10));
 return new Date(value).toISOString();
}
function dateOnly(value){
 if(typeof value!=='string'||!/^\d{4}-\d\d-\d\d$/.test(value)||Number.isNaN(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)throw fail('Provide an observed assignment due date as YYYY-MM-DD.');
 return value;
}
function sourceUrl(value,courseId,{course=false,origin}={}){
 let url;try{url=new URL(value);}catch{throw fail('Provide a Canvas course source URL.');}
 if(url.protocol!=='https:'||!url.hostname.endsWith('.instructure.com')||url.username||url.password||url.port||origin&&url.origin!==origin)throw fail('Use an HTTPS Canvas URL without credentials.');
 const prefix='/courses/'+courseId;
 if(course?![prefix,prefix+'/'].includes(url.pathname):url.pathname!==prefix&&!url.pathname.startsWith(prefix+'/'))throw fail('The Canvas URL must belong to this course.');
 // Store direct course-page references, without browser tokens or tracking queries.
 url.search='';url.hash='';return url.href;
}
function projection(value,syncedAt){
 if(!value||typeof value!=='object'||Array.isArray(value))throw fail('Provide an observed Canvas course.');
 const courseId=String(value.courseId??'');
 if(!/^\d{1,32}$/.test(courseId)||!roles.has(value.role))throw fail('Provide the Canvas course ID and an explicit student or TA role.');
 const title=text(value.title,'a course title',200),term=text(value.term,'an observed course term',80),code=text(value.code,'a course code',120,{optional:true});
 if(value.historicalExample!==undefined&&typeof value.historicalExample!=='boolean')throw fail('The historical example flag must be true or false.');
 const url=sourceUrl(value.url,courseId,{course:true}),origin=new URL(url).origin,sourceScope=text(value.sourceScope,'the observed source scope',2000);
 if(!Array.isArray(value.assignments)||value.assignments.length>2000)throw fail('Provide up to 2,000 explicitly observed assignments.');
 const ids=new Set(),assignments=value.assignments.map(assignment=>{
  if(!assignment||typeof assignment!=='object'||Array.isArray(assignment))throw fail('Provide an observed assignment.');
  const id=String(assignment.id??'');
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(id)||ids.has(id))throw fail('Assignment IDs must be explicit and unique within a course.');
  ids.add(id);const result={id,title:text(assignment.title,'an assignment title',300)};
  if(assignment.url!==undefined)result.url=sourceUrl(assignment.url,courseId,{origin});
  if(assignment.dueDate!==undefined&&assignment.dueDate!==null)result.dueDate=dateOnly(assignment.dueDate);
  if(assignment.dueAt!==undefined&&assignment.dueAt!==null)result.dueAt=instant(assignment.dueAt,'the observed assignment deadline');
  if(assignment.displayDue!==undefined)result.displayDue=text(assignment.displayDue,'the displayed deadline',300,{optional:true,preserve:true});
  return result;
 });
 const result={version:1,courseId,title,code,term,role:value.role,url,syncedAt,sourceScope,syncMethod:'manual-browser',historicalExample:value.historicalExample??false,assignments};
 if(value.syllabus!==undefined&&value.syllabus!==null){
  if(typeof value.syllabus!=='object'||Array.isArray(value.syllabus))throw fail('Provide observed syllabus text or its Canvas URL.');
  const syllabus={};
  if(value.syllabus.url!==undefined)syllabus.url=sourceUrl(value.syllabus.url,courseId,{origin});
  if(value.syllabus.text!==undefined)syllabus.text=text(value.syllabus.text,'observed syllabus text',200000,{optional:true,preserve:true});
  if(!Object.keys(syllabus).length)throw fail('Provide observed syllabus text or its Canvas URL.');
  result.syllabus=syllabus;
 }
 if(Buffer.byteLength(JSON.stringify(result))>maxSnapshotBytes)throw fail('This observed course snapshot is too large.',413);
 return result;
}
function slug(value){
 const cleaned=value.normalize('NFKC').trim().replace(/[^\p{L}\p{N}\p{M}_ -]/gu,'').replace(/\s+/g,'-');
 let result='';for(const character of cleaned){if(Buffer.byteLength(result+character)>180)break;result+=character;}
 if(!result)throw fail('The course title and term must contain letters or numbers.');return result;
}
function folderParts(folder){
 if(typeof folder!=='string'||folder.includes('\\')||folder.includes('\0'))throw fail('Choose a course folder inside this workspace.',403);
 const parts=folder.split('/');
 if(parts.length!==3||parts[0]!=='courses'||parts.some(part=>!part||part==='.'||part==='..'||part.startsWith('.')))throw fail('Choose a course folder inside this workspace.',403);
 return parts;
}
async function directory(path){
 const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path)throw fail('Course folders must be real folders inside this workspace.',403);
}
async function courseFolder(base,folder){
 const parts=folderParts(folder);await directory(resolve(base,'courses'));await directory(resolve(base,'courses',parts[1]));
 const path=resolve(base,folder);await directory(path);return path;
}
async function readSnapshot(base,folder){
 const directory=await courseFolder(base,folder),file=resolve(directory,'.canvas.json');let handle;
 try{
  handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);const info=await handle.stat();
  if(!info.isFile()||info.size>maxSnapshotBytes)throw fail('The saved Canvas snapshot needs repair.',422);
  const body=await handle.readFile(),data=JSON.parse(body.toString('utf8'));
  if(data?.version!==1)throw fail('The saved Canvas snapshot needs repair.',422);
  let snapshot;try{snapshot=projection(data,instant(data.syncedAt,'the saved observation time'));}catch{throw fail('The saved Canvas snapshot needs repair.',422);}
  return{snapshot,body};
 }catch(e){
  if(e.code==='ENOENT')return null;
  if(e.code==='ELOOP')throw fail('A Canvas snapshot cannot be a symbolic link.',403);
  if(e instanceof SyntaxError)throw fail('The saved Canvas snapshot needs repair.',422);
  throw e;
 }finally{if(handle)await handle.close();}
}
export async function readCanvasCourseSnapshot(root,folder){return(await readSnapshot(await realpath(root),folder))?.snapshot||null;}
async function writeSnapshot(base,folder,body){
 const directory=await courseFolder(base,folder),file=resolve(directory,'.canvas.json'),temporary=resolve(directory,'.canvas.'+randomUUID()+'.tmp');
 try{const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())throw fail('A Canvas snapshot must be a regular file.',403);}catch(e){if(e.code!=='ENOENT')throw e;}
 let handle;
 try{handle=await open(temporary,'wx',0o600);await handle.writeFile(body);await handle.close();handle=null;await rename(temporary,file);}
 finally{if(handle)await handle.close().catch(()=>{});await unlink(temporary).catch(()=>{});}
}
async function existingCourses(base){
 const courses=resolve(base,'courses');await directory(courses);const found=new Map();
 for(const term of await readdir(courses,{withFileTypes:true})){
  if(!term.isDirectory()||term.isSymbolicLink()||term.name.startsWith('.'))continue;
  for(const entry of await readdir(resolve(courses,term.name),{withFileTypes:true})){
   if(!entry.isDirectory()||entry.isSymbolicLink()||entry.name.startsWith('.'))continue;
   const folder='courses/'+term.name+'/'+entry.name,stored=await readSnapshot(base,folder);if(!stored)continue;
   const identity=stored.snapshot.courseId+':'+stored.snapshot.role;
   if(found.has(identity))throw fail('This Canvas course and role appear in more than one local folder.',409);
   found.set(identity,{folder,...stored});
  }
 }
 return found;
}
function initialReadme(snapshot){
 return'---\ntitle: '+JSON.stringify(snapshot.title)+'\nsummary: ""\nstatus: ""\nnext: ""\nsemester: '+JSON.stringify(snapshot.term)+'\ncourse_role: '+JSON.stringify(snapshot.role)+'\nhistorical_example: '+snapshot.historicalExample+'\ncanvas_course_id: '+JSON.stringify(snapshot.courseId)+'\n---\n\n# '+snapshot.title+'\n\n[Open Canvas course]('+snapshot.url+')\n';
}
async function removeNewCourse(base,folder){
 const directory=resolve(base,folder);
 for(const name of ['.canvas.json','README.md'])await unlink(resolve(directory,name)).catch(()=>{});
 for(const name of ['notes','files'])await rmdir(resolve(directory,name)).catch(()=>{});
 await rmdir(directory).catch(()=>{});
}
async function importProjection(base,courses,observedAt){
 const existing=await existingCourses(base),identities=new Set(),paths=new Set(),plans=[];
 for(const source of courses){
  const snapshot=projection(source,observedAt),identity=snapshot.courseId+':'+snapshot.role;
  if(identities.has(identity))throw fail('Import each Canvas course and role only once.',409);identities.add(identity);
  const previous=existing.get(identity);
  if(previous&&source.historicalExample===undefined)snapshot.historicalExample=previous.snapshot.historicalExample;
  if(previous&&Date.parse(snapshot.syncedAt)<Date.parse(previous.snapshot.syncedAt))throw fail('An older observation cannot replace this course snapshot.',409);
  const folder=previous?.folder||'courses/'+slug(snapshot.term)+'/'+slug(snapshot.title);
  if(paths.has(folder))throw fail('These observed courses resolve to the same local folder.',409);paths.add(folder);
  const parts=folderParts(folder),term=resolve(base,'courses',parts[1]);
  try{await directory(term);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!previous){try{await lstat(resolve(base,folder));throw fail('A different local course already uses this folder. Its contents were kept.',409);}catch(e){if(e.code!=='ENOENT')throw e;}}
  const body=Buffer.from(JSON.stringify(snapshot,null,2)+'\n'),unchanged=previous&&body.equals(previous.body);
  plans.push({folder,snapshot,body,previous,status:unchanged?'unchanged':previous?'updated':'created'});
 }
 const applied=[];
 try{
  for(const plan of plans){
   if(plan.status==='unchanged')continue;
   if(!plan.previous){
    const term=resolve(base,'courses',folderParts(plan.folder)[1]);await mkdir(term,{recursive:true});await directory(term);
    try{await mkdir(resolve(base,plan.folder));}catch(e){if(e.code==='EEXIST')throw fail('A different local course already uses this folder. Its contents were kept.',409);throw e;}
    applied.push(plan);
    await mkdir(resolve(base,plan.folder,'notes'));await mkdir(resolve(base,plan.folder,'files'));
    await writeFile(resolve(base,plan.folder,'README.md'),initialReadme(plan.snapshot),{flag:'wx',mode:0o600});
   }else applied.push(plan);
   await writeSnapshot(base,plan.folder,plan.body);
  }
 }catch(e){
  for(const plan of applied.reverse()){
   if(plan.previous)await writeSnapshot(base,plan.folder,plan.previous.body).catch(()=>{});
   else await removeNewCourse(base,plan.folder);
  }
  throw e;
 }
 return{observedAt,created:plans.filter(p=>p.status==='created').length,updated:plans.filter(p=>p.status==='updated').length,unchanged:plans.filter(p=>p.status==='unchanged').length,courses:plans.map(({folder,snapshot,status})=>({path:folder+'/README.md',courseId:snapshot.courseId,role:snapshot.role,status}))};
}
export async function importCanvasCourses(root,{courses,observedAt}={}){
 const when=instant(observedAt,'the browser observation time');
 if(!Array.isArray(courses)||!courses.length||courses.length>50)throw fail('Provide between 1 and 50 explicitly observed Canvas courses.');
 const base=await realpath(root),previous=importQueues.get(base)||Promise.resolve();
 const current=previous.catch(()=>{}).then(()=>importProjection(base,courses,when));importQueues.set(base,current);
 try{return await current;}finally{if(importQueues.get(base)===current)importQueues.delete(base);}
}
