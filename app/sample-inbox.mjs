import {readFile,open,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const baseline=JSON.parse(await readFile(new URL('./sample-inbox-baseline.json',import.meta.url),'utf8'));
const hash=value=>createHash('sha256').update(value).digest('hex');
function references(value,path){
 if(typeof value==='string')return value===path;
 if(Array.isArray(value))return value.some(row=>references(row,path));
 return value&&typeof value==='object'&&Object.values(value).some(row=>references(row,path));
}
export async function sampleInbox(root,files,ideas,{records,filings}){
 const result=[];let hasHistory=false;
 try{await lstat(resolve(root,'inbox/.edit-history'));hasHistory=true;}catch(error){if(error.code!=='ENOENT')hasHistory=true;}
 for(const row of files){const seed=baseline.files.find(seed=>seed.path===row.path);if(!seed)continue;let reason='',file;
  try{file=await open(resolve(root,row.path),constants.O_RDONLY|constants.O_NOFOLLOW);const info=await file.stat();if(!info.isFile()||info.size>32*1024*1024||hash(await file.readFile())!==seed.sha256||row.uploadedAt!==seed.uploadedAt)reason='This file differs from the original sample or was uploaded again.';}catch{reason='The original sample file could not be verified.';}finally{await file?.close();}
  if(!reason&&hasHistory)reason='Inbox notes have saved edit history.';
  if(!reason&&filings.items.some(entry=>entry.sourcePath===row.path))reason='This file has been filed into a workspace.';
  if(!reason&&references(records,row.path))reason='Saved records reference this file.';
  result.push({id:hash(row.path).slice(0,20),path:row.path,title:row.name,kind:'file',eligible:!reason,reason});
 }
 for(const idea of ideas){const seed=baseline.ideas.find(row=>row.id===idea.id);if(!seed)continue;const eligible=Object.keys(seed).every(key=>idea[key]===seed[key]);result.push({id:idea.id,title:idea.text.slice(0,140),kind:'idea',eligible,reason:eligible?'':'This idea has been edited since the sample was created.'});}
 return result;
}
