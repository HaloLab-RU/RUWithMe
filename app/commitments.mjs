import {randomUUID} from 'node:crypto';
import {withCommitments,zonedInstant,moveDeleted} from './todos.mjs';
import {readCalendar,validDate} from './records.mjs';
import {safeFile} from './workspace.mjs';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const statuses=['open','in-progress','waiting','done','cancelled'];
function text(value,label,max=1000,required=false){if(value==null)value='';if(typeof value!=='string'||value.trim().length>max||required&&!value.trim())throw fail(`Enter a valid ${label} (${required?'1–':'up to '}${max} characters).`);return value.trim();}
function find(store,id){const row=store.items.find(r=>r.id===id&&r.kind!=='todo');if(!row)throw fail('This commitment no longer exists. Refresh the list.',404);return row;}
function changeStatus(row,status,at){if(row.status===status)return;const from=row.status;row.status=status;row.completedAt=status==='done'?at:null;row.history=[...(row.history||[]),{id:randomUUID(),action:'status-changed',from,to:status,at}];}
async function fields(workspace,input){
 const title=text(input.title,'commitment',1000,true),category=input.category||'personal';
 if(!['research','courses','learn','career','admin','personal','other'].includes(category))throw fail('Choose a valid category.');
 if(!validDate(input.dueDate))throw fail('Enter a valid deadline date.');
 const ownerPath=input.ownerPath||null;
 if(ownerPath){if(typeof ownerPath!=='string'||!ownerPath.startsWith((category==='other'?'personal':category)+'/')||!ownerPath.endsWith('/README.md'))throw fail('The linked workspace does not match the category.');await safeFile(workspace,ownerPath);}
 const {timeZone}=await readCalendar(workspace);
 const dueAt=input.dueTime?zonedInstant(input.dueDate+'T'+input.dueTime,timeZone):null;
 return{title,category,ownerPath,dueDate:dueAt?null:input.dueDate,dueAt,timeZone,person:text(input.person,'person',300),deliverable:text(input.deliverable,'deliverable',2000),waitingOn:text(input.waitingOn,'waiting item',1000)};
}
export class CommitmentService{
 constructor({workspace,now=()=>new Date()}){this.workspace=workspace;this.now=now;}
 async delete(input){return moveDeleted(this.workspace,input,{todo:false,now:this.now});}
 async restore(input){return moveDeleted(this.workspace,input,{todo:false,restore:true,now:this.now});}
 async create(input){
  if(typeof input.requestId!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.requestId))throw fail('Use a new commitment request ID.');
  const data=await fields(this.workspace,input),status=input.status||'open';if(!statuses.slice(0,3).includes(status))throw fail('Choose a valid initial status.');
  return withCommitments(this.workspace,input.expectedRevision,store=>{const existing=[...store.items,...(store.trash||[])].find(r=>r.id===input.requestId);if(existing){if(existing.kind!=='commitment')throw fail('Commitment ID conflict.',409);if(existing.deletedAt)throw fail('This commitment was deleted. Restore it from Deleted instead of recreating it.',409);return{unchanged:true,value:existing};}const at=this.now().toISOString(),row={id:input.requestId,kind:'commitment',revision:1,...data,status,createdAt:at,updatedAt:at,completedAt:null,history:[]};store.items.push(row);return{value:row};});
 }
 async update(input){const data=await fields(this.workspace,input);if(input.status!==undefined&&!statuses.includes(input.status))throw fail('Choose a valid commitment status.');return withCommitments(this.workspace,input.expectedRevision,store=>{const row=find(store,input.id),at=this.now().toISOString();if(input.status!==undefined)changeStatus(row,input.status,at);Object.assign(row,data,{updatedAt:at,revision:(row.revision||0)+1});return{value:row};});}
 async status(input){
  if(!statuses.includes(input.status))throw fail('Choose a valid commitment status.');
  return withCommitments(this.workspace,input.expectedRevision,store=>{const row=find(store,input.id);if(row.status===input.status)return{unchanged:true,value:row};const at=this.now().toISOString();changeStatus(row,input.status,at);row.updatedAt=at;row.revision=(row.revision||0)+1;return{value:row};});
 }
}
export async function handleCommitmentRequest(req,res,{service,daily,origin,json}){
 const path=new URL(req.url,origin).pathname;if(!path.startsWith('/api/commitments/'))return false;
 const action=path.slice('/api/commitments/'.length);
 if(!['create','update','status','delete','restore'].includes(action)){json(res,404,{error:'Not found'});return true;}
 if(req.method!=='POST'){json(res,405,{error:'Method not allowed'});return true;}
 if(req.headers.origin!==origin||req.headers['x-ruwithme-csrf']!==daily.csrf){json(res,403,{error:'Refresh before changing a commitment.'});return true;}
 if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json'){json(res,415,{error:'JSON required'});return true;}
 const chunks=[];let size=0;for await(const chunk of req.iterator({destroyOnReturn:false})){size+=chunk.length;if(size>16000){req.resume();json(res,413,{error:'Request too large'});return true;}chunks.push(chunk);}
 const input=JSON.parse(Buffer.concat(chunks,size).toString('utf8'));if(!input||typeof input!=='object'||Array.isArray(input))throw fail('A JSON object is required.');
 json(res,200,await service[action](input));return true;
}
