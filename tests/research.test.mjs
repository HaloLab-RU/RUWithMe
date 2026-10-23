import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,readdir,writeFile,symlink,rm,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ResearchService,readResearchPriorities} from '../app/research.mjs';
import {indexWorkspace,createItem,safeFile} from '../app/workspace.mjs';
import {createRequestHandler} from '../app/server.mjs';
const executeFile=promisify(execFile),storePath=root=>join(root,'research','.priorities.json');

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'ruwithme-research-'));
 for(const category of ['research','courses','learn','inbox'])await mkdir(join(root,category));
 t.after(()=>rm(root,{recursive:true,force:true}));return root;
}
const service=root=>new ResearchService({workspace:root,createItem});
async function project(root,title){const created=await createItem(root,{category:'research',title});return(await indexWorkspace(root)).items.research.find(item=>item.path===created.path);}
async function serverFixture(t){
 const root=await fixture(t);let handler;
 const server=http.createServer((req,res)=>handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');
 const port=server.address().port,origin='http://127.0.0.1:'+port,headers={Origin:origin,'X-RUWithMe-CSRF':'research-test','Content-Type':'application/json'};
 handler=createRequestHandler({workspace:root,port,daily:{csrf:'research-test'}});
 t.after(()=>new Promise((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections();}));
 return{root,origin,post:(path,data,overrides={})=>fetch(origin+path,{method:'POST',headers:{...headers,...overrides},body:JSON.stringify(data)})};
}

test('legacy Research stays unassigned, read-only index does not create a store or rewrite README',async t=>{
 const root=await fixture(t),a=await project(root,'Example-Study'),file=join(root,a.path);
 await writeFile(file,'---\ntitle: "Example-Study"\nstatus: "paused"\n---\n\n# Example-Study\nOriginal notes.\n');
 const before=await readFile(file),snapshot=await indexWorkspace(root);
 assert.deepEqual(snapshot.research,{version:1,revision:0});
 assert.equal(snapshot.items.research[0].priority,null);assert.equal(snapshot.items.research[0].priorityOrder,null);assert.equal(snapshot.items.research[0].status,'paused');
 assert.deepEqual(await readFile(file),before);assert.deepEqual(await readdir(join(root,'research')),['Example-Study']);
 assert.equal((await readResearchPriorities(root)).revision,0);
 await assert.rejects(safeFile(root,'research/.priorities.json'),{status:403});
});

test('priorities and manual level order survive restart independently of status and file contents',async t=>{
 const root=await fixture(t),api=service(root),a=await project(root,'Alpha'),b=await project(root,'Beta'),c=await project(root,'中文 research');
 await writeFile(join(root,a.folder,'notes','original.md'),'keep these bytes');
 const original=await readFile(join(root,a.path));
 let out=await api.update({id:a.id,priority:'p1',expectedRevision:0});assert.equal(out.revision,1);
 out=await api.update({id:b.id,priority:'p1',expectedRevision:1});assert.equal(out.priorityOrder,1);
 out=await api.update({id:b.id,priority:'p1',beforeId:a.id,expectedRevision:2});assert.equal(out.revision,3);assert.equal(out.priorityOrder,0);
 out=await api.update({id:c.id,priority:'p2',expectedRevision:3});assert.equal(out.revision,4);
 let snapshot=await indexWorkspace(root);assert.deepEqual(snapshot.items.research.map(item=>item.title),['Beta','Alpha','中文 research']);
 assert.deepEqual(snapshot.items.research.map(item=>item.priorityOrder),[0,1,0]);
 const script="import {indexWorkspace} from "+JSON.stringify(new URL('../app/workspace.mjs',import.meta.url).href)+"; const s=await indexWorkspace(process.argv[1]); console.log(JSON.stringify({research:s.research,items:s.items.research.map(({id,priority,priorityOrder})=>({id,priority,priorityOrder}))}));";
 const fresh=JSON.parse((await executeFile(process.execPath,['--input-type=module','-e',script,root])).stdout);
 assert.deepEqual(fresh.research,snapshot.research);assert.deepEqual(fresh.items,snapshot.items.research.map(({id,priority,priorityOrder})=>({id,priority,priorityOrder})));
 out=await api.update({id:b.id,priority:'p3',expectedRevision:4});assert.equal(out.priority,'p3');assert.equal(out.priorityOrder,0);
 out=await api.update({id:a.id,priority:null,expectedRevision:5});assert.equal(out.priority,null);assert.equal(out.priorityOrder,null);
 snapshot=await indexWorkspace(root);assert.deepEqual(snapshot.items.research.map(item=>item.id),[c.id,b.id,a.id]);
 assert.deepEqual(await readFile(join(root,a.path)),original);assert.equal(await readFile(join(root,a.folder,'notes','original.md'),'utf8'),'keep these bytes');
 assert.equal(snapshot.items.research.flatMap(item=>item.files).some(item=>item.path.includes('.priorities')),false);
});

test('changes require current revision and a destination in the target level; no-ops preserve revision',async t=>{
 const root=await fixture(t),api=service(root),a=await project(root,'Alpha'),b=await project(root,'Beta');
 await api.update({id:a.id,priority:'p1',expectedRevision:0});const bytes=await readFile(storePath(root));
 assert.equal((await api.update({id:a.id,priority:'p1',beforeId:a.id,expectedRevision:1})).revision,1);
 assert.equal((await api.update({id:a.id,priority:'p1',expectedRevision:1})).revision,1);
 await assert.rejects(api.update({id:b.id,priority:'p2',beforeId:a.id,expectedRevision:1}),{status:400});
 await assert.rejects(api.update({id:a.id,priority:null,beforeId:b.id,expectedRevision:1}),{status:400});
 await assert.rejects(api.update({id:a.id,priority:'p2',expectedRevision:0}),{status:409});
 await assert.rejects(api.update({id:'0'.repeat(20),priority:'p1',expectedRevision:1}),{status:404});
 await assert.rejects(api.update({id:a.id,priority:'urgent',expectedRevision:1}),{status:400});
 assert.deepEqual(await readFile(storePath(root)),bytes);
});

test('parallel edits conflict instead of losing updates, while parallel creates serialize',async t=>{
 const root=await fixture(t),api=service(root),a=await project(root,'Alpha'),b=await project(root,'Beta');
 const edits=await Promise.allSettled([api.update({id:a.id,priority:'p1',expectedRevision:0}),api.update({id:b.id,priority:'p2',expectedRevision:0})]);
 assert.equal(edits.filter(item=>item.status==='fulfilled').length,1);assert.equal(edits.find(item=>item.status==='rejected').reason.status,409);
 const created=await Promise.all([api.create({title:'Gamma',priority:'p3'}),service(root).create({title:'Delta',priority:null})]);
 // Concurrent callers may enter the serialized queue in either order.
 assert.deepEqual(created.map(item=>item.revision).sort((a,b)=>a-b),[2,3]);
 const snapshot=await indexWorkspace(root);assert.equal(snapshot.research.revision,3);assert.equal(snapshot.counts.research,4);
 for(const title of ['Gamma','Delta'])for(const name of ['README.md','notes','files'])assert.ok(await lstat(join(root,'research',title,name)));
 const before=await readFile(storePath(root));await assert.rejects(api.create({title:'Gamma',priority:'p1'}),{status:409});assert.deepEqual(await readFile(storePath(root)),before);
 const generic=await project(root,'Generic');assert.equal(generic.priority,null);assert.equal((await indexWorkspace(root)).research.revision,3);
});

test('overall index revision includes canonical priority revision even if visible ordering is identical',async t=>{
 const root=await fixture(t),api=service(root);await api.create({title:'Alpha',priority:null});const first=await indexWorkspace(root);
 const data=JSON.parse(await readFile(storePath(root),'utf8'));data.revision++;await writeFile(storePath(root),JSON.stringify(data));
 const second=await indexWorkspace(root);assert.deepEqual(second.items,first.items);assert.notEqual(second.revision,first.revision);assert.equal(second.research.revision,2);
});

test('corrupt, traversal and symlink priority stores are refused without changing user data',async t=>{
 const root=await fixture(t),a=await project(root,'Alpha'),api=service(root),original=await readFile(join(root,a.path));
 for(const value of ['{broken',JSON.stringify({version:1,revision:1,levels:{p1:['research/../README.md'],p2:[],p3:[]}}),JSON.stringify({version:1,revision:1,levels:{p1:[a.path],p2:[a.path],p3:[]}})]){
  await writeFile(storePath(root),value);await assert.rejects(indexWorkspace(root),{status:422});await assert.rejects(api.create({title:'Never created',priority:'p3'}),{status:422});assert.equal(await readFile(storePath(root),'utf8'),value);
 }
 await rm(storePath(root));const target=join(root,'protected.json');await writeFile(target,'sensitive fixture bytes');await symlink(target,storePath(root));
 await assert.rejects(readResearchPriorities(root),{status:403});await assert.rejects(api.update({id:a.id,priority:'p1',expectedRevision:0}),{status:403});assert.equal(await readFile(target,'utf8'),'sensitive fixture bytes');
 await rm(storePath(root));await rm(join(root,a.path));await symlink(target,join(root,a.path));
 await writeFile(storePath(root),JSON.stringify({version:1,revision:0,levels:{p1:[a.path],p2:[],p3:[]}}));await assert.rejects(readResearchPriorities(root),{status:403});
 await rm(join(root,a.path));await writeFile(join(root,a.path),original);await rm(storePath(root));
 await rm(join(root,'research'),{recursive:true});await mkdir(join(root,'elsewhere'));await symlink(join(root,'elsewhere'),join(root,'research'));
 await assert.rejects(api.create({title:'Never created',priority:'p3'}),{status:403});assert.deepEqual(await readdir(join(root,'elsewhere')),[]);
});

test('failed priority registration rolls back only the newly created empty scaffold',async t=>{
 const root=await fixture(t),target=join(root,'protected.json');await writeFile(target,'untouched');
 const api=new ResearchService({workspace:root,createItem:async(base,args)=>{const created=await createItem(base,args);await symlink(target,storePath(base));return created;}});
 await assert.rejects(api.create({title:'New project',priority:'p3'}),{status:403});assert.equal(await readFile(target,'utf8'),'untouched');
 assert.deepEqual(await readdir(join(root,'research')),['.priorities.json']);
});

test('failed registration preserves the entire project when concurrent notes have been added',async t=>{
 const root=await fixture(t),target=join(root,'protected.json');await writeFile(target,'untouched');
 const api=new ResearchService({workspace:root,createItem:async(base,args)=>{
  const created=await createItem(base,args),folder=join(base,created.path.slice(0,-10));
  await writeFile(join(folder,'notes','concurrent.md'),'new user content');await symlink(target,storePath(base));return created;
 }});
 await assert.rejects(api.create({title:'Keep project',priority:'p3'}),{status:403});
 assert.match(await readFile(join(root,'research','Keep-project','README.md'),'utf8'),/Keep project/);
 assert.equal(await readFile(join(root,'research','Keep-project','notes','concurrent.md'),'utf8'),'new user content');
});

test('Research HTTP mutations enforce origin, CSRF, method, JSON size and revision',async t=>{
 const {root,origin,post}=await serverFixture(t),path='/api/research/create',body={title:'HTTP research',priority:'p3'};
 assert.equal((await fetch(origin+path)).status,405);
 assert.equal((await post(path,body,{Origin:'http://example.com'})).status,403);
 assert.equal((await post(path,body,{Origin:''})).status,403);
 assert.equal((await post(path,body,{'X-RUWithMe-CSRF':'wrong'})).status,403);
 assert.equal((await post(path,body,{'Content-Type':'text/plain'})).status,415);
 assert.equal((await post(path,{title:'x'.repeat(17000),priority:'p3'})).status,413);
 assert.equal((await post(path,[])).status,400);assert.deepEqual(await readdir(join(root,'research')),[]);
 let response=await post(path,body);assert.equal(response.status,201);const created=await response.json();assert.equal(created.revision,1);assert.equal(created.priorityOrder,0);
 response=await post('/api/research/update',{id:created.id,priority:'p1',beforeId:null,expectedRevision:1});assert.equal(response.status,200);assert.equal((await response.json()).revision,2);
 assert.equal((await post('/api/research/update',{id:created.id,priority:'p2',beforeId:null,expectedRevision:1})).status,409);
 const snapshot=await(await fetch(origin+'/api/workspace')).json();assert.equal(snapshot.items.research[0].priority,'p1');assert.equal(snapshot.research.revision,2);
});
