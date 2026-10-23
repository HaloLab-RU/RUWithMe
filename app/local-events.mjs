import {randomUUID} from 'node:crypto';
import {commitCalendar} from './google-calendar.mjs';
import {zonedInstant} from './todos.mjs';
import {readCalendar,validDate} from './records.mjs';
import {safeFile} from './workspace.mjs';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export async function saveLocalEvent(workspace,input={}){
 if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)throw fail('Read the current Calendar before saving.');
 const calendar=await readCalendar(workspace),id=input.id||randomUUID();if(typeof id!=='string'||! /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id))throw fail('Choose a local event identity.');
 const existing=calendar.events.find(row=>row.id===id);if(input.id&&!existing)throw fail('This event is no longer available.',404);if(existing?.sourceId)throw fail('Edit imported events in their original calendar.',409);
 if(input.cancel===true){if(!existing)throw fail('Choose an event to cancel.');return commitCalendar(workspace,input.expectedRevision,current=>{const row=current.events.find(row=>row.id===id);if(!row||row.sourceId)throw fail('The local event changed.',409);row.status='cancelled';row.updatedAt=new Date().toISOString();current.revision++;return current;});}
 if(typeof input.title!=='string'||!input.title.trim()||input.title.length>300||typeof input.location!=='string'||input.location.length>500||typeof input.allDay!=='boolean')throw fail('Enter an event title, location and time.');
 const ownerPath=input.ownerPath||null;if(ownerPath){if(typeof ownerPath!=='string'||! /^(?:(?:research|learn|career|admin|personal)\/[^/]+|courses\/[^/]+\/[^/]+)\/README\.md$/.test(ownerPath))throw fail('Choose a workspace.');await safeFile(workspace,ownerPath);}
 const period=input.allDay?{startDate:input.startDate,endDate:input.endDate}:{startAt:zonedInstant(input.startLocal,calendar.timeZone),endAt:zonedInstant(input.endLocal,calendar.timeZone)};
 if(input.allDay?(!validDate(period.startDate)||!validDate(period.endDate)||period.endDate<=period.startDate):period.endAt<=period.startAt)throw fail('The end must be later than the start.');
 const now=new Date().toISOString(),row={id,title:input.title.trim(),location:input.location.trim(),ownerPath,allDay:input.allDay,timeZone:calendar.timeZone,status:'confirmed',...period,createdAt:existing?.createdAt||now,updatedAt:now,...(existing?.synthetic?{synthetic:true}:{})};
 return commitCalendar(workspace,input.expectedRevision,current=>{const index=current.events.findIndex(entry=>entry.id===id);if(index>=0){if(current.events[index].sourceId)throw fail('Imported event ownership changed.',409);current.events[index]=row;}else current.events.push(row);current.revision++;return current;});
}
export async function handleLocalEventRequest(req,res,{workspace,daily,origin,json}){
 if(new URL(req.url,origin).pathname!=='/api/calendar/local/save')return false;
 if(req.method!=='POST'){json(res,405,{error:'Method not allowed'});return true;}
 if(req.headers.origin!==origin||req.headers['x-ruwithme-csrf']!==daily.csrf){json(res,403,{error:'Refresh before changing local events.'});return true;}
 if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json'){json(res,415,{error:'JSON required'});return true;}
 let size=0;const chunks=[];for await(const chunk of req.iterator({destroyOnReturn:false})){size+=chunk.length;if(size>16000){req.resume();json(res,413,{error:'Request too large'});return true;}chunks.push(chunk);}const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!input||typeof input!=='object'||Array.isArray(input))throw fail('A JSON object is required.');await saveLocalEvent(workspace,input);json(res,200,{saved:true});return true;
}
