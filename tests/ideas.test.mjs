import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,readdir,writeFile,symlink,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createInboxIdea,updateInboxIdea,uploadInboxFile,createInboxLink,indexWorkspace,safeFile} from '../app/workspace.mjs';
import {createRequestHandler} from '../app/server.mjs';
const executeFile=promisify(execFile);

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'ruwithme-ideas-'));
 for(const category of ['research','courses','learn','inbox'])await mkdir(join(root,category));
 t.after(()=>rm(root,{recursive:true,force:true}));return root;
}
async function serverFixture(t){
 const root=await fixture(t);let handler;
 const server=http.createServer((req,res)=>handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');
 const port=server.address().port,origin='http://127.0.0.1:'+port,headers={Origin:origin,'X-RUWithMe-CSRF':'ideas-test','Content-Type':'application/json'};
 handler=createRequestHandler({workspace:root,port,daily:{csrf:'ideas-test'}});
 t.after(()=>new Promise((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections();}));
 return{root,origin,post:(path,data,overrides={})=>fetch(origin+path,{method:'POST',headers:{...headers,...overrides},body:JSON.stringify(data)})};
}

test('listing an empty Inbox creates no files; Ideas remain separate from existing Markdown',async t=>{
 const root=await fixture(t),empty=await indexWorkspace(root);
 assert.deepEqual(empty.ideas,[]);assert.deepEqual(await readdir(join(root,'inbox')),[]);
 const original='# My existing note\n\nKeep this source unchanged.\n';
 await writeFile(join(root,'inbox/old-note.md'),original);
 const before=await indexWorkspace(root),idea=await createInboxIdea(root,{text:'An idea that belongs in its own card'}),after=await indexWorkspace(root);
 assert.equal(after.ideas[0].id,idea.id);assert.equal(after.inbox.length,1);assert.equal(after.inbox[0].name,'old-note.md');
 assert.equal(after.counts.inbox,2);assert.notEqual(after.revision,before.revision);
 assert.equal(await readFile(join(root,'inbox/old-note.md'),'utf8'),original);
 assert.deepEqual((await readdir(join(root,'inbox'))).sort(),['.ideas.json','old-note.md']);
 await assert.rejects(safeFile(root,'inbox/.ideas.json'),e=>e.status===403);
});

test('multiline idea text, stable IDs and timestamps survive editing and a fresh process',async t=>{
 const root=await fixture(t),text='  想法第一行\n\n第二行 😀\t<literal & text>  ',created=await createInboxIdea(root,{text});
 assert.equal(created.text,text);assert.equal(created.revision,1);assert.equal(created.createdAt,created.updatedAt);
 const updatedText=text+'\n下一步：检查条件。\n',before=await indexWorkspace(root),updated=await updateInboxIdea(root,{id:created.id,text:updatedText,expectedRevision:1});
 assert.equal(updated.id,created.id);assert.equal(updated.createdAt,created.createdAt);assert.equal(updated.text,updatedText);assert.equal(updated.revision,2);
 assert.ok(Date.parse(updated.updatedAt)>Date.parse(created.updatedAt));
 const after=await indexWorkspace(root);assert.notEqual(after.revision,before.revision);assert.equal(after.inbox.length,0);assert.equal(after.counts.inbox,1);
 const code='const {indexWorkspace}=await import(process.argv[1]);process.stdout.write(JSON.stringify(await indexWorkspace(process.argv[2])));';
 const {stdout}=await executeFile(process.execPath,['--input-type=module','-e',code,new URL('../app/workspace.mjs',import.meta.url).href,root]);
 assert.deepEqual(JSON.parse(stdout).ideas,[updated]);
 const sidecar=join(root,'inbox/.ideas.json'),inode=(await stat(sidecar)).ino,snapshot=after.revision;
 assert.deepEqual(await updateInboxIdea(root,{id:updated.id,text:updatedText,expectedRevision:2}),updated);
 assert.equal((await stat(sidecar)).ino,inode);assert.equal((await indexWorkspace(root)).revision,snapshot);
});

test('text limits count Unicode characters and reject empty input without touching content',async t=>{
 const root=await fixture(t),text='😀'.repeat(10000),saved=await createInboxIdea(root,{text});
 assert.equal(saved.text,text);
 const original=await readFile(join(root,'inbox/.ideas.json'),'utf8');
 for(const invalid of [undefined,null,12,'',' \n\t ','😀'.repeat(10001)])await assert.rejects(createInboxIdea(root,{text:invalid}),e=>e.status===400);
 await assert.rejects(updateInboxIdea(root,{id:saved.id,text:'valid',expectedRevision:'1'}),e=>e.status===400);
 await assert.rejects(updateInboxIdea(root,{id:'../other',text:'valid',expectedRevision:1}),e=>e.status===400);
 await assert.rejects(updateInboxIdea(root,{id:randomUUID(),text:'valid',expectedRevision:1}),e=>e.status===404);
 assert.equal(await readFile(join(root,'inbox/.ideas.json'),'utf8'),original);
});

test('concurrent stale edits cannot overwrite an idea and mixed Inbox changes remain independent',async t=>{
 const root=await fixture(t),created=await createInboxIdea(root,{text:'Original'});
 const edits=await Promise.allSettled(['First edit','Second edit'].map(text=>updateInboxIdea(root,{id:created.id,text,expectedRevision:1})));
 assert.equal(edits.filter(result=>result.status==='fulfilled').length,1);
 assert.equal(edits.find(result=>result.status==='rejected').reason.status,409);
 const winner=edits.find(result=>result.status==='fulfilled').value;
 await assert.rejects(updateInboxIdea(root,{id:created.id,text:winner.text,expectedRevision:1}),e=>e.status===409);
 const [another,file,website]=await Promise.all([
  createInboxIdea(root,{text:'Another card'}),
  uploadInboxFile(root,'source.pdf',Buffer.from('original bytes')),
  createInboxLink(root,{url:'https://example.com',title:'Website'})
 ]);
 const indexed=await indexWorkspace(root);assert.deepEqual(indexed.ideas,[winner,another]);assert.equal(indexed.inbox.length,2);assert.equal(indexed.counts.inbox,4);
 assert.equal(indexed.inbox.find(row=>row.path===file.path).uploadedAt,file.uploadedAt);
 assert.equal(indexed.inbox.find(row=>row.path===website.path).addedAt,website.addedAt);
 assert.ok(!(await readdir(join(root,'inbox'))).some(name=>name.endsWith('.tmp')));
});

test('malformed or symlinked Ideas storage is preserved and cannot redirect writes',async t=>{
 const root=await fixture(t),saved=await createInboxIdea(root,{text:'Keep this idea'}),file=join(root,'inbox/.ideas.json'),original=await readFile(file,'utf8');
 for(const invalid of ['{broken',JSON.stringify({version:2,ideas:[]}),JSON.stringify({version:1,ideas:[saved,saved]}),JSON.stringify({version:1,ideas:[{...saved,revision:0}]})]){
  await writeFile(file,invalid);
  await assert.rejects(createInboxIdea(root,{text:'New'}),e=>e.status===422);
  await assert.rejects(updateInboxIdea(root,{id:saved.id,text:'Changed',expectedRevision:1}),e=>e.status===422);
  await assert.rejects(indexWorkspace(root),e=>e.status===422);
  assert.equal(await readFile(file,'utf8'),invalid);
 }
 const outside=join(root,'research/protected.json');await writeFile(outside,original);await rm(file);await symlink(outside,file);
 await assert.rejects(createInboxIdea(root,{text:'Redirected'}),e=>e.status===403);
 await assert.rejects(updateInboxIdea(root,{id:saved.id,text:'Changed',expectedRevision:1}),e=>e.status===403);
 await assert.rejects(indexWorkspace(root),e=>e.status===403);
 assert.equal(await readFile(outside,'utf8'),original);
 await rm(file);await writeFile(file,original);assert.deepEqual((await indexWorkspace(root)).ideas,[saved]);
});

test('HTTP Idea endpoints require local origin, CSRF, JSON and bounded requests',async t=>{
 const {root,origin,post}=await serverFixture(t);
 for(const path of ['/api/inbox/ideas','/api/inbox/ideas/update']){
  for(const override of [{Origin:''},{Origin:'https://example.com'},{'X-RUWithMe-CSRF':'wrong'},{'Sec-Fetch-Site':'cross-site'}]){
   const response=await post(path,{text:'Blocked'},override);assert.equal(response.status,403);await response.json();
  }
  const type=await post(path,{text:'Wrong type'},{'Content-Type':'text/plain'});assert.equal(type.status,415);await type.json();
  const method=await fetch(origin+path);assert.equal(method.status,405);await method.json();
  const shape=await post(path,[]);assert.equal(shape.status,400);await shape.json();
  const tooLarge=await post(path,{text:'x'.repeat(64*1024)});assert.equal(tooLarge.status,413);await tooLarge.json();
 }
 assert.deepEqual(await readdir(join(root,'inbox')),[]);
 const createdResponse=await post('/api/inbox/ideas',{text:'First\n\nline'});assert.equal(createdResponse.status,201);const idea=await createdResponse.json();
 const updatedResponse=await post('/api/inbox/ideas/update',{id:idea.id,text:'Edited\nidea',expectedRevision:1});assert.equal(updatedResponse.status,200);const edited=await updatedResponse.json();assert.equal(edited.revision,2);
 const stale=await post('/api/inbox/ideas/update',{id:idea.id,text:'Overwritten?',expectedRevision:1});assert.equal(stale.status,409);await stale.json();
 const missing=await post('/api/inbox/ideas/update',{id:randomUUID(),text:'Missing',expectedRevision:1});assert.equal(missing.status,404);await missing.json();
 const indexed=await(await fetch(origin+'/api/workspace')).json();assert.deepEqual(indexed.ideas,[edited]);assert.deepEqual(indexed.inbox,[]);assert.equal(indexed.counts.inbox,1);
 const hidden=await fetch(origin+'/api/file?path='+encodeURIComponent('inbox/.ideas.json'));assert.equal(hidden.status,403);await hidden.json();
});
