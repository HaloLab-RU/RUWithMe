import {open,realpath,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {readSessions} from './records.mjs';
import {readContent,saveContent} from './content.mjs';
import {readDemo} from './demo.mjs';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
async function session(root,id){const row=(await readSessions(root)).items.find(row=>row.id===id);if(!row?.ownerPath)throw fail('Choose a saved session linked to a workspace.',404);return row;}
export async function contextProposal(root,id){
 const row=await session(root,id),note=await readContent(root,row.ownerPath);if(!note.fields)throw fail('This session is not linked to a workspace overview.',400);
 return{appliedFields:note.contextSource?.id===row.id&&note.contextSource?.revision===row.revision?note.contextSource.fields:[],source:{id:row.id,revision:row.revision,date:row.date,workedOn:row.workedOn,synthetic:row.synthetic===true},path:row.ownerPath,expectedRevision:note.revision,current:{currentUnderstanding:note.fields.currentUnderstanding,openQuestions:note.fields.openQuestions,next:note.fields.next},suggested:{currentUnderstanding:row.outcome,openQuestions:row.blockers,next:row.nextStep},sampleBlocked:row.synthetic===true&&!await readDemo(root)};
}
export async function applySessionContext(root,{id,expectedSessionRevision,expectedRevision,changes,confirmed}={}){
 if(confirmed!==true||!changes||typeof changes!=='object'||Array.isArray(changes)||!Object.keys(changes).length||Object.entries(changes).some(([key,value])=>!['currentUnderstanding','openQuestions','next'].includes(key)||typeof value!=='string'||value.length>10000))throw fail('Select and review the project fields, then confirm the update.');
 const base=await realpath(root),lockPath=resolve(base,'records/.sessions.lock');let lock;
 try{
  try{lock=await open(lockPath,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw fail('Sessions are being updated. Review the saved session and try again.',409);throw error;}
  const row=await session(base,id);if(row.revision!==expectedSessionRevision)throw fail('This session changed. Review its latest version before updating the project.',409);
  if(row.synthetic===true&&!await readDemo(base))throw fail('Sample sessions cannot update real project context. Log your own session first.',409);
  const note=await readContent(base,row.ownerPath);if(note.revision!==expectedRevision)throw fail('The project changed. Keep your draft and review the latest project context.',409);
  return await saveContent(base,{path:row.ownerPath,expectedRevision,fields:{...note.fields,...changes}},{contextSource:{id:row.id,revision:row.revision,date:row.date,fields:Object.keys(changes)}});
 }finally{if(lock){await lock.close();await unlink(lockPath).catch(()=>{});}}
}
export async function handleSessionContextRequest(req,res,{workspace,daily,origin,json}){
 const url=new URL(req.url,origin);if(!['/api/sessions/project-context','/api/sessions/project-context/save'].includes(url.pathname))return false;
 if(url.pathname==='/api/sessions/project-context'&&req.method==='GET'){json(res,200,await contextProposal(workspace,url.searchParams.get('id')));return true;}
 if(url.pathname!=='/api/sessions/project-context/save'||req.method!=='POST'){json(res,405,{error:'Method not allowed'});return true;}
 if(req.headers.origin!==origin||req.headers['x-ruwithme-csrf']!==daily.csrf){json(res,403,{error:'Refresh before updating project context.'});return true;}
 if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json'){json(res,415,{error:'JSON required'});return true;}
 let size=0;const chunks=[];for await(const chunk of req.iterator({destroyOnReturn:false})){size+=chunk.length;if(size>160000)throw fail('Request too large',413);chunks.push(chunk);}
 const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!input||typeof input!=='object'||Array.isArray(input))throw fail('A JSON object is required.');json(res,200,await applySessionContext(workspace,input));return true;
}
