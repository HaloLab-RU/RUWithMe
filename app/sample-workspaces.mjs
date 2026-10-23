import {readFile,readdir,open,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {sampleCandidates} from './demo.mjs';
// Exact original seed bytes, independent of source labels or file timestamps.
const baseline=JSON.parse(await readFile(new URL('./sample-project-baseline.json',import.meta.url),'utf8'));
async function unchanged(root,item,seed){
 const base=await realpath(root),folder=resolve(base,item.folder);
 if(await realpath(folder)!==folder)return false;
 const paths=[],directories=[];let safe=true;
 async function walk(dir=''){
  for(const entry of await readdir(resolve(folder,dir),{withFileTypes:true})){
   const path=dir?dir+'/'+entry.name:entry.name;
   if(entry.isSymbolicLink()){safe=false;continue;}
   if(entry.isDirectory()){directories.push(path);await walk(path);}
   else if(entry.isFile())paths.push(path);else safe=false;
  }
 }
 await walk();if(!safe||JSON.stringify(paths.sort())!==JSON.stringify(Object.keys(seed.files).sort())||JSON.stringify(directories.sort())!==JSON.stringify(seed.directories))return false;
 for(const path of paths){let file;try{file=await open(resolve(folder,path),constants.O_RDONLY|constants.O_NOFOLLOW);const info=await file.stat();if(!info.isFile()||info.size>32*1024*1024)return false;const hash=createHash('sha256').update(await file.readFile()).digest('hex');if(hash!==seed.files[path])return false;}finally{await file?.close();}}
 return true;
}
function references(value,folder){
 if(typeof value==='string')return value===folder+'/README.md'||value.startsWith(folder+'/');
 if(Array.isArray(value))return value.some(row=>references(row,folder));
 return value&&typeof value==='object'&&Object.values(value).some(row=>references(row,folder));
}
export async function sampleWorkspaces(root,items,records,{materials,filings,priorities}){
 const candidate=sampleCandidates(records),untouched=new Set(Object.values(candidate).flat().map(row=>row.id));
 const personal=[...records.commitments.items,...(records.commitments.trash||[]),...records.calendar.events,...records.calendar.workBlocks,...records.sessions.items,...records.track.entries,...records.track.drafts].filter(row=>!untouched.has(row.id));
 const result=[];
 for(const item of Object.values(items).flat()){
  const seed=baseline.projects.find(row=>row.path===item.path);if(!seed)continue;
  let reason='';
  try{if(!await unchanged(root,item,seed))reason='Project notes, files or edit history differ from the original sample.';}catch{reason='Project files could not be verified against the original sample.';}
  if(!reason&&materials.items.some(row=>row.path.startsWith(item.folder+'/')))reason='You added properties to a project file.';
  if(!reason&&filings.items.some(row=>references(row,item.folder)))reason='An Inbox file was filed into this project.';
  if(!reason&&personal.some(row=>references(row,item.folder)))reason='Personal or edited records reference this project.';
  if(!reason&&item.path.startsWith('research/')&&priorities.revision>1)reason='Research priorities have been changed since the sample was created.';
  result.push({id:item.id,path:item.path,title:item.title,eligible:!reason,reason});
 }
 return result;
}
