import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,extname} from 'node:path';
import {CodexService,handleCodexRequest} from './codex-service.mjs';
import {handleGoogleRequest} from './google-calendar.mjs';
import {CodexCalendarService} from './codex-calendar.mjs';
import {TodoService,handleTodoRequest} from './todos.mjs';
import {CommitmentService,handleCommitmentRequest} from './commitments.mjs';
import {TrackService,handleTrackRequest} from './track.mjs';
import {SessionService,handleSessionRequest} from './sessions.mjs';
import {ResearchService} from './research.mjs';
import {handleLocalEventRequest} from './local-events.mjs';
import {handleMaterialRequest} from './materials.mjs';
import {handleContentRequest} from './content.mjs';
import {handleDailyModeRequest} from './daily-mode.mjs';
import {handleSessionContextRequest} from './session-context.mjs';
import {indexWorkspace,createItem,safeFile,uploadInboxFile,createInboxLink,renameInboxFile,createInboxIdea,updateInboxIdea,MAX_SOURCE_BYTES} from './workspace.mjs';
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
const assets={'/workspace-mode-ui.js':'workspace-mode-ui.js','/local-events-ui.js':'local-events-ui.js','/today-ui.js':'today-ui.js','/materials-ui.js':'materials-ui.js','/pdf-ui.js':'pdf-ui.js','/polish.css':'polish.css','/vendor/pdf.mjs':'../node_modules/pdfjs-dist/build/pdf.mjs','/vendor/pdf.worker.mjs':'../node_modules/pdfjs-dist/build/pdf.worker.mjs','/content-ui.js':'content-ui.js','/content.css':'content.css','/appearance.js':'appearance.js','/appearance.css':'appearance.css','/task-cards.css':'task-cards.css','/sessions-ui.js':'sessions-ui.js','/freshness-ui.js':'freshness-ui.js','/sessions.css':'sessions.css','/':'index.html','/index.html':'index.html','/app.js':'app.js','/styles.css':'styles.css','/ru-mark.svg':'ru-mark.svg','/calendar-ui.js':'calendar-ui.js','/calendar.css':'calendar.css','/todo-ui.js':'todo-ui.js','/todos.css':'todos.css','/commitment-ui.js':'commitment-ui.js','/commitments.css':'commitments.css','/daily-ui.js':'daily-ui.js','/daily.css':'daily.css','/track-ui.js':'track-ui.js','/track.css':'track.css','/research-ui.js':'research-ui.js','/research.css':'research.css'};
const inboxJsonRoutes=new Map([
 ['/api/inbox/rename',{status:200,run:renameInboxFile,limit:16000}],
 ['/api/inbox/links',{status:201,run:createInboxLink,limit:16000}],
 ['/api/inbox/ideas',{status:201,run:createInboxIdea,limit:64*1024}],
 ['/api/inbox/ideas/update',{status:200,run:updateInboxIdea,limit:64*1024}]
]);
export function createRequestHandler({workspace,daily,port,google,appRoot=fileURLToPath(new URL('.',import.meta.url))}){const sessions=new SessionService({workspace}),todos=new TodoService({workspace,google}),commitments=new CommitmentService({workspace}),track=new TrackService({workspace,daily,projectRoot:resolve(appRoot,'..')}),research=new ResearchService({workspace,createItem});return async(req,res)=>{
 try{
  const host=req.headers.host,origin='http://'+host;
  if(!['127.0.0.1:'+port,'localhost:'+port].includes(host)){json(res,403,{error:'Invalid host'});return;}
  const callback=req.method==='GET'&&new URL(req.url,origin).pathname==='/api/calendar/google/callback';
  if(!callback&&(req.headers.origin&&req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site')){json(res,403,{error:'Invalid origin'});return;}
  if(await handleDailyModeRequest(req,res,{workspace,daily,origin,json}))return;
  if(await handleSessionContextRequest(req,res,{workspace,daily,origin,json}))return;
  if(await handleLocalEventRequest(req,res,{workspace,daily,origin,json}))return;
  if(await handleMaterialRequest(req,res,{workspace,daily,origin,json}))return;
  if(await handleContentRequest(req,res,{workspace,daily,origin,json}))return;
  if(await handleSessionRequest(req,res,{service:sessions,daily,origin,json}))return;
  if(await handleTodoRequest(req,res,{service:todos,daily,origin,json}))return;
  if(await handleCommitmentRequest(req,res,{service:commitments,daily,origin,json}))return;
  if(await handleTrackRequest(req,res,{service:track,daily,origin,json}))return;
  if(await handleGoogleRequest(req,res,{service:google,daily,origin,json}))return;
  if(await handleCodexRequest(req,res,{service:daily,origin}))return;
  const url=new URL(req.url,origin);
  if(['/api/research/update','/api/research/create'].includes(url.pathname)){
   if(req.method!=='POST'){json(res,405,{error:'Method not allowed'});return;}
   if(req.headers.origin!==origin||req.headers['x-ruwithme-csrf']!==daily.csrf){json(res,403,{error:'Refresh the page before changing Research priorities.'});return;}
   if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json'){json(res,415,{error:'JSON required'});return;}
   const limit=16000;if(Number(req.headers['content-length'])>limit){req.resume();json(res,413,{error:'Request too large'});return;}
   let size=0;const chunks=[];
   for await(const chunk of req.iterator({destroyOnReturn:false})){size+=chunk.length;if(size>limit){req.resume();json(res,413,{error:'Request too large'});return;}chunks.push(chunk);}
   const data=JSON.parse(Buffer.concat(chunks,size).toString('utf8'));
   if(!data||typeof data!=='object'||Array.isArray(data))throw Object.assign(new Error('A JSON object is required.'),{status:400});
   const create=url.pathname==='/api/research/create';json(res,create?201:200,await research[create?'create':'update'](data));return;
  }
  if(url.pathname==='/api/inbox/files'){
   if(req.method!=='POST'){json(res,405,{error:'Method not allowed'});return;}
   if(req.headers.origin!==origin||req.headers['x-ruwithme-csrf']!==daily.csrf){json(res,403,{error:'Refresh the page before uploading a file.'});return;}
   if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/octet-stream'){json(res,415,{error:'Binary file required'});return;}
   if(Number(req.headers['content-length'])>MAX_SOURCE_BYTES){req.resume();json(res,413,{error:'Upload supports files up to 32 MB.'});return;}
   const chunks=[];let size=0;
   for await(const chunk of req.iterator({destroyOnReturn:false})){
    size+=chunk.length;
    if(size>MAX_SOURCE_BYTES){req.resume();json(res,413,{error:'Upload supports files up to 32 MB.'});return;}
    chunks.push(chunk);
   }
   json(res,201,await uploadInboxFile(workspace,url.searchParams.get('name'),Buffer.concat(chunks,size)));return;
  }
  const inboxRoute=inboxJsonRoutes.get(url.pathname);
  if(inboxRoute){
   if(req.method!=='POST'){json(res,405,{error:'Method not allowed'});return;}
   if(req.headers.origin!==origin||req.headers['x-ruwithme-csrf']!==daily.csrf){json(res,403,{error:'Refresh the page before changing Inbox.'});return;}
   if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json'){json(res,415,{error:'JSON required'});return;}
   if(Number(req.headers['content-length'])>inboxRoute.limit){req.resume();json(res,413,{error:'Request too large'});return;}
   let size=0;const chunks=[];
   for await(const chunk of req.iterator({destroyOnReturn:false})){
    size+=chunk.length;if(size>inboxRoute.limit){req.resume();json(res,413,{error:'Request too large'});return;}chunks.push(chunk);
   }
   const data=JSON.parse(Buffer.concat(chunks,size).toString('utf8'));
   if(!data||typeof data!=='object'||Array.isArray(data))throw Object.assign(new Error('A JSON object is required.'),{status:400});
   json(res,inboxRoute.status,await inboxRoute.run(workspace,data));return;
  }
  if(url.pathname==='/api/items'){
   if(req.method!=='POST'){json(res,405,{error:'Method not allowed'});return;}
   if(req.headers.origin!==origin||req.headers['x-ruwithme-csrf']!==daily.csrf){json(res,403,{error:'Refresh the page before creating a workspace.'});return;}
   if(!req.headers['content-type']?.startsWith('application/json')){json(res,415,{error:'JSON required'});return;}
   req.setEncoding('utf8');let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>6000)throw Object.assign(new Error('Request too large'),{status:413});}
   json(res,201,await createItem(workspace,JSON.parse(body)));return;
  }
  if(!['GET','HEAD'].includes(req.method)){json(res,405,{error:'Method not allowed'});return;}
  if(url.pathname==='/api/workspace'){json(res,200,await indexWorkspace(workspace));return;}
  if(url.pathname==='/api/file'){
   const source=await safeFile(workspace,url.searchParams.get('path')),body=req.method==='HEAD'?null:await readFile(source.file);
   const mime={'.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'}[extname(source.path).toLowerCase()]||'text/plain; charset=utf-8';
   res.writeHead(200,{'Content-Type':mime,'Content-Length':source.info.size,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"frame-ancestors 'self'",'Referrer-Policy':'no-referrer'});res.end(body);return;
  }
  const file=assets[url.pathname];if(!file){json(res,404,{error:'Not found'});return;}
  const body=await readFile(resolve(appRoot,file)),type={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'}[extname(file)];
  res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:body);
 }catch(e){if(!res.destroyed)json(res,e.status||(e.code==='ENOENT'?404:e instanceof SyntaxError?400:500),{error:e.message});}
};}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
const appRoot=fileURLToPath(new URL('.',import.meta.url)),root=resolve(appRoot,'..'),workspace=resolve(root,'workspace'),port=Number(process.env.PORT||4191);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Choose a port between 1024 and 65535.');
const daily=new CodexService({workspaceRoot:workspace,projectRoot:root,sessionFile:resolve(root,'.ruwithme/codex/session.json'),appOrigin:'http://127.0.0.1:'+port});
const google=new CodexCalendarService({daily,workspace,privateRoot:resolve(root,'.ruwithme/calendar')});
const server=http.createServer(createRequestHandler({workspace,daily,port,google,appRoot}));
server.on('error',e=>{console.error(e.code==='EADDRINUSE'?`RUWithMe's port ${port} is already in use. Open http://127.0.0.1:${port} if it is already running.`:e.message);process.exitCode=1;});
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{daily.close();server.close();process.exit(0);});
server.listen(port,'127.0.0.1',()=>console.log(`RUWithMe: http://127.0.0.1:${port}\nWorkspace: ${workspace}`));
}
