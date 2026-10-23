import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve} from 'node:path';
import {validDate} from './records.mjs';
async function manifest(root){
 let handle;try{handle=await open(resolve(root,'.demo.json'),constants.O_RDONLY|constants.O_NOFOLLOW);const info=await handle.stat();if(!info.isFile()||info.size>2*1024*1024)throw new Error('Invalid workspace mode settings.');const data=JSON.parse(await handle.readFile('utf8'));if(data?.version!==1)throw new Error('Invalid workspace mode settings.');if(data.mode==='daily'&&data.synthetic===false){if(!Number.isFinite(Date.parse(data.startedAt))||!data.archived||Object.entries(data.archived).some(([key,ids])=>!['tasks','events','blocks','sessions','entries','drafts','workspaces','inboxFiles','inboxIdeas'].includes(key)||!Array.isArray(ids)||ids.length>10000||ids.some(id=>typeof id!=='string'||id.length>120)))throw new Error('Invalid daily mode settings.');return data;}if(data.synthetic!==true||!validDate(data.scenarioDate))throw new Error('Invalid demo manifest.');return data;}
 catch(error){if(error.code==='ENOENT')return null;throw error;}finally{await handle?.close();}
}
export async function readDemo(root){const data=await manifest(root);return data?.synthetic===true?data:null;}
export async function readWorkspaceMode(root){const data=await manifest(root);return data?.mode==='daily'?data:null;}
export function sampleCandidates(records){
 const {commitments,calendar,sessions,track}=records,untouched=row=>row.synthetic===true&&(row.revision??1)===1&&!row.updatedAt&&!row.locallyEdited&&!row.google;
 const protectedTasks=new Set([...commitments.items,...(commitments.trash||[])].filter(row=>row.synthetic!==true||(row.revision??1)>1).map(row=>row.parentCommitmentId).filter(Boolean));
 for(const row of calendar.workBlocks)if(row.synthetic!==true||row.updatedAt||row.google)protectedTasks.add(row.commitmentId);
 const tasks=commitments.items.filter(row=>row.synthetic===true&&(row.revision??1)===1&&!protectedTasks.has(row.id));
 const entries=track.entries.filter(row=>row.synthetic===true),entryIds=new Set(entries.map(row=>row.id));
 const keepDrafts=new Set(track.entries.filter(row=>!entryIds.has(row.id)).map(row=>row.draftId));
 return{tasks,events:calendar.events.filter(untouched),blocks:calendar.workBlocks.filter(untouched),sessions:sessions.items.filter(row=>row.synthetic===true&&row.revision===1),entries,drafts:track.drafts.filter(row=>row.synthetic===true&&row.status!=='pending'&&!keepDrafts.has(row.id))};
}
export function dailyView(records,mode){
 if(!mode)return records;const candidates=sampleCandidates(records),hidden={};for(const key of Object.keys(candidates))hidden[key]=new Set(candidates[key].filter(row=>mode.archived[key]?.includes(row.id)).map(row=>row.id));
 return{...records,commitments:{...records.commitments,items:records.commitments.items.filter(row=>!hidden.tasks.has(row.id))},calendar:{...records.calendar,events:records.calendar.events.filter(row=>!hidden.events.has(row.id)),workBlocks:records.calendar.workBlocks.filter(row=>!hidden.blocks.has(row.id))},sessions:{...records.sessions,items:records.sessions.items.filter(row=>!hidden.sessions.has(row.id))},track:{...records.track,entries:records.track.entries.filter(row=>!hidden.entries.has(row.id)),drafts:records.track.drafts.filter(row=>!hidden.drafts.has(row.id))}};
}
export async function workspaceDay(root,now,zone){const demo=await readDemo(root);return demo?.scenarioDate||new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);}
