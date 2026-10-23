import {constants} from 'node:fs';
import {mkdir,writeFile,readFile,rename,lstat,readdir,realpath,open} from 'node:fs/promises';
import {resolve,dirname,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {indexWorkspace} from '../app/workspace.mjs';
import {emptyCalendar,emptyCommitments,emptySessions,emptyTrack,validateCalendar,validateCommitments,validateSessions,validateTrack,validDate} from '../app/records.mjs';

const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const defaultDate='2026-10-22';
const expectedCounts={research:3,courses:2,learn:3,career:0,admin:2,personal:2,inbox:0};
const priorities={p1:['research/Robust-Distribution-Shift/README.md'],p2:['research/Sequential-Uncertainty/README.md'],p3:['research/Adaptive-Inference/README.md']};
const writeJSON=(root,path,value)=>writeFile(resolve(root,path),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const within=(root,path)=>{const part=relative(root,path);return part===''||part!=='..'&&!part.startsWith('..'+sep)&&!part.startsWith(sep);};

async function realDirectory(path){
 const full=resolve(path),info=await lstat(full);
 if(!info.isDirectory()||info.isSymbolicLink()||await realpath(full)!==full)throw new Error('Layout demo requires real directories without symbolic links: '+full);
 return full;
}

async function verifiedSource(root,path,hash){
 const file=resolve(root,path);if(!within(root,file)||file===root)throw new Error('Invalid synthetic baseline path.');
 let parent=root;const parts=relative(root,file).split(sep);
 for(const part of parts.slice(0,-1)){parent=resolve(parent,part);await realDirectory(parent);}
 const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())throw new Error('Synthetic baseline files cannot be symbolic links: '+path);
 let handle;try{handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);const bytes=await handle.readFile();if(createHash('sha256').update(bytes).digest('hex')!==hash)throw new Error('Synthetic baseline changed; preserve and review before replacing: '+path);return bytes;}finally{await handle?.close();}
}

async function noSymlinks(root){
 await realDirectory(root);
 for(const entry of await readdir(root,{withFileTypes:true})){
  if(entry.isSymbolicLink())throw new Error('Layout demo staging cannot contain symbolic links.');
  if(entry.isDirectory())await noSymlinks(resolve(root,entry.name));
  else if(!entry.isFile())throw new Error('Layout demo staging requires regular files.');
 }
}

async function validateLayout(root,date){
 await noSymlinks(root);
 const index=await indexWorkspace(root);
 if(JSON.stringify(index.counts)!==JSON.stringify(expectedCounts))throw new Error('Layout demo card counts do not match the reviewed fixture.');
 if(Object.values(index.items).flat().some(item=>!item.exampleWorkspace))throw new Error('Layout demo cards must be explicitly synthetic.');
 if(index.demo?.synthetic!==true||index.demo.scenarioDate!==date||index.mode!==null)throw new Error('Layout demo must use its synthetic scenario without daily archives.');
 const records=index.records;
 validateCommitments(records.commitments);validateCalendar(records.calendar);validateSessions(records.sessions);validateTrack(records.track);
 if(records.commitments.items.length||(records.commitments.trash??[]).length||records.calendar.sources.length||records.calendar.events.length||records.calendar.workBlocks.length||records.sessions.items.length||records.track.drafts.length||records.track.entries.length||records.days.length||index.inbox.length||index.ideas.length)throw new Error('Layout demo activity views must be empty.');
 if(records.calendar.timeZone!=='America/New_York')throw new Error('Layout demo must use the New York time zone.');
 for(const [level,paths] of Object.entries(priorities))if(index.items.research.filter(item=>item.priority===level).map(item=>item.path).join('\n')!==paths.join('\n'))throw new Error('Layout demo must keep the original synthetic Research priorities.');
 return index;
}

export async function buildLayoutDemo(root,{sourceRoot=resolve(projectRoot,'workspace'),date=defaultDate}={}){
 if(!validDate(date))throw new Error('Use a valid layout demo scenario date.');
 const source=await realDirectory(sourceRoot),target=resolve(root);
 if(within(source,target)||within(target,source))throw new Error('Layout demo staging and source workspace must be separate directories.');
 await mkdir(target,{recursive:true});await realDirectory(target);
 if((await readdir(target)).length)throw new Error('Layout demo staging must be empty.');
 const baseline=JSON.parse(await readFile(resolve(projectRoot,'app/sample-project-baseline.json'),'utf8'));
 // Read and verify all retained bytes before writing any of them. Only named
 // baseline paths are copied; real additions and hidden edit history stay private.
 const retained=[];
 for(const item of baseline.projects){
  const folder=dirname(item.path);
  for(const sub of item.directories)await realDirectory(resolve(source,folder,sub));
  for(const [path,hash] of Object.entries(item.files)){const name=folder+'/'+path;retained.push([name,await verifiedSource(source,name,hash)]);}
 }
 for(const area of ['research','courses','learn','career','admin','personal','inbox','records'])await mkdir(resolve(target,area));
 for(const item of baseline.projects)for(const sub of item.directories)await mkdir(resolve(target,dirname(item.path),sub),{recursive:true});
 for(const [path,bytes] of retained){await mkdir(dirname(resolve(target,path)),{recursive:true});await writeFile(resolve(target,path),bytes,{flag:'wx'});}
 async function card(area,folder,title,summary,next,notes){
  const base=resolve(target,area,folder);for(const sub of ['notes','files'])await mkdir(resolve(base,sub),{recursive:true});
  const fields={title,summary,status:'Not started',next};
  await writeFile(resolve(base,'README.md'),'---\n'+Object.entries(fields).map(([key,value])=>key+': '+JSON.stringify(value)).join('\n')+'\n---\n\n# '+title+'\n\n> Synthetic example - not a record of your work.\n\n'+notes+'\n',{flag:'wx'});
 }
 await card('admin','Conference-Travel','Conference Travel','Plan the practical details of an example academic trip.','Draft a checklist for registration, transport and accommodation.','## Planning outline\n- Compare travel options and estimate costs.\n- Identify reimbursement documents to collect.\n\n## Checkpoint\nPrepare one checklist that can guide a future booking.');
 await card('admin','Department-Forms','Department Forms','Keep an example department paperwork checklist in one place.','List the forms and information to confirm with the department.','## Planning outline\n- Identify required forms and the right office.\n- Prepare questions before starting an application.\n\n## Checkpoint\nMatch each form with the information needed to complete it.');
 await card('personal','Weekly-Routine','Weekly Routine','Plan a manageable example routine for meals, exercise and errands.','Choose one small routine to try during a future week.','## Planning outline\n- Draft a simple meal and grocery plan.\n- Leave time for exercise and rest.\n\n## Checkpoint\nChoose a routine small enough to fit a busy research week.');
 await card('personal','Weekend-Plans','Weekend Plans','Collect low-pressure ideas for an example weekend.','Choose one activity and check the practical details.','## Planning outline\n- Consider a walk, a museum visit or time with friends.\n- Keep an open block for rest.\n\n## Checkpoint\nSelect one practical option while keeping the rest of the day flexible.');
 await card('learn','Probabilistic-Artificial-Intelligence','Probabilistic Artificial Intelligence','Read about uncertainty and decision making using a public textbook.','Read the introduction and write questions about epistemic and aleatoric uncertainty.','## Source\n[Probabilistic Artificial Intelligence](https://arxiv.org/abs/2502.05244), Andreas Krause and Jonas Hübotter.\n\nThe source is real; this reading plan is a synthetic example.\n\n## Reading outline\n- Distinguish epistemic and aleatoric uncertainty.\n- Review probabilistic inference.\n- Explore how uncertainty informs active learning, Bayesian optimization and reinforcement learning.\n\n## Checkpoint\nExplain one uncertainty-aware decision example after reading. No reading progress has been recorded.');
 await writeJSON(target,'research/.priorities.json',{version:1,revision:1,levels:priorities});
 await writeJSON(target,'records/commitments.json',emptyCommitments());
 await writeJSON(target,'records/calendar.json',emptyCalendar());
 await writeJSON(target,'records/sessions.json',emptySessions());
 await writeJSON(target,'records/track.json',emptyTrack());
 await mkdir(resolve(target,'records/days'));
 await writeJSON(target,'inbox/.ideas.json',{version:1,ideas:[]});
 await writeJSON(target,'inbox/.metadata.json',{version:1,files:{}});
 await writeJSON(target,'.demo.json',{version:1,synthetic:true,scenarioDate:date,title:'Synthetic workspace layout preview',description:'All active workspace content is synthetic. Public reading references are real sources. Original example project files are retained; Today, Track, Calendar, work sessions, Inbox and Career start empty. No example activity is the user\'s actual work.'});
 return validateLayout(target,date);
}

export async function replaceWithLayoutDemo({root=resolve(projectRoot,'workspace'),date=defaultDate,maintenanceRoot=resolve(dirname(root),'.ruwithme')}={}){
 const source=await realDirectory(root),maintenance=resolve(maintenanceRoot);
 if(within(source,maintenance)||within(maintenance,source))throw new Error('Maintenance storage must be outside the workspace.');
 await mkdir(maintenance,{recursive:true});await realDirectory(maintenance);
 const stageParent=resolve(maintenance,'staging'),backupParent=resolve(maintenance,'backups/layout-demo');
 for(const folder of [stageParent,backupParent]){await mkdir(folder,{recursive:true});await realDirectory(folder);}
 const staging=resolve(stageParent,'layout-demo-'+randomUUID()),stamp=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8),backup=resolve(backupParent,stamp),archived=resolve(backup,'workspace');
 await buildLayoutDemo(staging,{sourceRoot:source,date});await realDirectory(staging);
 // rename() must stay on one filesystem so moving originals is reversible.
 if((await lstat(source)).dev!==(await lstat(staging)).dev||(await lstat(source)).dev!==(await lstat(backupParent)).dev)throw new Error('Workspace, staging and backup must be on one filesystem.');
 await mkdir(backup);let moved=false,installed=false;
 try{
  await rename(source,archived);moved=true;
  await rename(staging,source);installed=true;
  const index=await validateLayout(source,date);
  await writeJSON(backup,'restore.json',{version:1,operation:'layout-demo',resetAt:new Date().toISOString(),workspace:source,archivedWorkspace:archived,scenarioDate:date,filesPreserved:true,note:'Stop RUWithMe before restoring. Move the active synthetic workspace aside, then rename the archived workspace back to the workspace path. The entire original workspace, including hidden metadata and edit history, is preserved. Runtime state, credentials and Daily chats were not moved.'});
  return{backup,archivedWorkspace:archived,counts:index.counts};
 }catch(error){
  if(installed)await rename(source,staging);
  if(moved)await rename(archived,source);
  throw error;
 }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(!process.argv.includes('--replace'))throw new Error('Use --replace explicitly. Stop RUWithMe first; this command archives the complete workspace and installs a synthetic layout preview.');
 console.log(JSON.stringify(await replaceWithLayoutDemo({date:process.argv.find(arg=>/^\d{4}-\d\d-\d\d$/.test(arg))||defaultDate}),null,2));
}
