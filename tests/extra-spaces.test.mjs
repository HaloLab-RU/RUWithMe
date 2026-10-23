import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,readdir,rm,realpath,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {once} from 'node:events';
import {createItem,indexWorkspace,safeFile} from '../app/workspace.mjs';
import {TodoService} from '../app/todos.mjs';
import {readRecords,emptyCalendar,emptyCommitments} from '../app/records.mjs';
import {createRequestHandler} from '../app/server.mjs';
async function fixture(t){const root=await realpath(await mkdtemp(join(tmpdir(),'ru-extra-spaces-')));for(const dir of ['research','courses','learn','inbox','records'])await mkdir(join(root,dir));await writeFile(join(root,'records/calendar.json'),JSON.stringify(emptyCalendar()));await writeFile(join(root,'records/commitments.json'),JSON.stringify(emptyCommitments()));await writeFile(join(root,'inbox/original.txt'),'Keep original');t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('older workspaces gain empty indexed spaces without read-time migrations or record writes',async t=>{
 const root=await fixture(t),before=await readdir(root),record=await readFile(join(root,'records/commitments.json'),'utf8'),indexed=await indexWorkspace(root);
 for(const category of ['career','admin','personal']){assert.deepEqual(indexed.items[category],[]);assert.equal(indexed.counts[category],0);}
 assert.deepEqual(await readdir(root),before);assert.equal(await readFile(join(root,'records/commitments.json'),'utf8'),record);
});
test('Career, Admin and Personal preserve original documents, stable identities and shared Todo ownership',async t=>{
 const root=await fixture(t),todos=new TodoService({workspace:root,now:()=>new Date('2026-10-20T15:00:00Z')});let expectedRevision=0;
 for(const category of ['career','admin','personal']){
  const item=await createItem(root,{category,title:category+' area'}),folder=item.path.slice(0,-10),bytes=Buffer.from('%PDF-original\n\0\xff','latin1');
  await writeFile(join(root,folder,'files/original.pdf'),bytes);await writeFile(join(root,folder,'notes/next.md'),'# A saved note');
  const index=await indexWorkspace(root),entry=index.items[category][0];assert.equal(entry.files.length,2);assert.equal(entry.path,item.path);assert.deepEqual(await readFile((await safeFile(root,folder+'/files/original.pdf')).file),bytes);
  const before=await readFile(join(root,item.path),'utf8');await assert.rejects(createItem(root,{category,title:category+' area'}),e=>e.status===409);assert.equal(await readFile(join(root,item.path),'utf8'),before);
  const task=await todos.create({requestId:randomUUID(),expectedRevision:expectedRevision++,title:'Next step for '+category,category,ownerPath:item.path,addToToday:true});assert.equal(task.category,category);assert.equal(task.ownerPath,item.path);
  const readme=before.replace('next: ""','next: "A user-supplied next step"');await writeFile(join(root,item.path),readme);const later=await indexWorkspace(root);assert.equal(later.items[category][0].id,entry.id);assert.equal(later.items[category][0].next,'A user-supplied next step');
 }
 const records=await readRecords(root);assert.equal(records.commitments.items.length,3);assert.equal(records.calendar.events.length,0);assert.equal(await readFile(join(root,'inbox/original.txt'),'utf8'),'Keep original');
});
test('new roots reject redirection and Todo cross-category links while legacy Personal tasks remain readable',async t=>{
 const root=await fixture(t),item=await createItem(root,{category:'personal',title:'Life'}),todos=new TodoService({workspace:root});
 await assert.rejects(todos.create({requestId:randomUUID(),expectedRevision:0,title:'Wrong owner',category:'career',ownerPath:item.path}),/does not match/);
 const task=await todos.create({requestId:randomUUID(),expectedRevision:0,title:'Legacy personal',category:'other',ownerPath:item.path});assert.equal(task.category,'other');assert.equal((await indexWorkspace(root)).records.commitments.items[0].id,task.id);
 await symlink(join(root,'personal'),join(root,'career'));await assert.rejects(indexWorkspace(root),e=>e.status===403);await assert.rejects(createItem(root,{category:'career',title:'Redirected'}),e=>e.status===403);
 for(const path of ['career/../records/calendar.json','personal/.secrets.json','personal/../../.ruwithme/session.json'])await assert.rejects(safeFile(root,path));
});
test('new-space HTTP create, index and original preview use the same protected local API',async t=>{
 const root=await fixture(t);let handler;const server=http.createServer((req,res)=>handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(done=>{server.close(done);server.closeAllConnections();}));const port=server.address().port,origin='http://127.0.0.1:'+port;handler=createRequestHandler({workspace:root,daily:{csrf:'spaces-test'},port});
 const r=await fetch(origin+'/api/items',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-RUWithMe-CSRF':'spaces-test'},body:JSON.stringify({category:'career',title:'Applications'})});assert.equal(r.status,201);const item=await r.json();
 const index=await(await fetch(origin+'/api/workspace')).json();assert.equal(index.items.career[0].path,item.path);assert.equal(index.counts.career,1);
 const file=item.path.slice(0,-10)+'/files/reference.html',html='<h1>My original document</h1>';await writeFile(join(root,file),html);const preview=await fetch(origin+'/api/file?path='+encodeURIComponent(file));assert.equal(preview.status,200);assert.match(preview.headers.get('content-type'),/text\/plain/);assert.equal(await preview.text(),html);
});
