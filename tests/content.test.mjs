import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,mkdir,readFile,readdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createItem,indexWorkspace} from '../app/workspace.mjs';
import {readContent,saveContent} from '../app/content.mjs';
import {createRequestHandler} from '../app/server.mjs';
import {importCanvasCourses} from '../app/courses.mjs';

async function fixture(t){const root=await mkdtemp(join(tmpdir(),'ruwithme-content-'));for(const folder of ['research','courses','learn','inbox'])await mkdir(join(root,folder));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('workspace editing persists fields and notes without moving identities or touching linked records',async t=>{
 const root=await fixture(t);
 for(const category of ['research','courses','learn']){
  const {path}=await createItem(root,{category,title:'Original',semester:'Fall 2026',courseRole:'ta'});
  const file=join(root,path),original=(await readFile(file,'utf8')).replace('---\n\n#','custom_field: "keep this"\n---\n\n#');await writeFile(file,original);
  const before=await indexWorkspace(root),saved=await readContent(root,path);
  const fields={...saved.fields,title:'Updated name',summary:'A question\nwith a second line',status:'Active',next:'Read theorem 2',notes:saved.fields.notes+'\n## Session context\nKeep this result.\n'};
  await saveContent(root,{path,expectedRevision:saved.revision,fields});
  const after=await indexWorkspace(root),item=after.items[category][0];
  assert.equal(item.id,before.items[category][0].id);assert.equal(item.path,path);assert.equal(item.title,'Updated name');assert.equal(item.next,'Read theorem 2');assert.equal(item.summary,fields.summary);assert.match(item.notes,/Keep this result/);
  assert.match(await readFile(file,'utf8'),/custom_field: "keep this"/);
  const folder=join(root,path.slice(0,-10),'.edit-history'),versions=await readdir(folder);
  assert.equal(versions.length,1);assert.equal(await readFile(join(folder,versions[0]),'utf8'),original);
  assert.deepEqual(after.records,before.records);if(category==='research')assert.deepEqual(after.research,before.research);if(category==='courses')assert.equal(item.courseRole,'ta');
 }
});
test('stale and concurrent editors preserve the winning save and previous original',async t=>{
 const root=await fixture(t),{path}=await createItem(root,{category:'research',title:'Proof'}),before=await readContent(root,path);
 const results=await Promise.allSettled(['First','Second'].map(status=>saveContent(root,{path,expectedRevision:before.revision,fields:{...before.fields,status}})));
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.find(result=>result.status==='rejected').reason.status,409);
 const latest=await readContent(root,path);assert.notEqual(latest.revision,before.revision);
 await assert.rejects(saveContent(root,{path,expectedRevision:before.revision,fields:before.fields}),{status:409});assert.deepEqual(await readContent(root,path),latest);
});
test('local course edits preserve Canvas snapshot bytes and survive later source refreshes',async t=>{
 const root=await fixture(t),course={courseId:'123',title:'Source Probability',code:'STAT 500',term:'Fall 2026',role:'ta',url:'https://rutgers.instructure.com/courses/123',sourceScope:'Observed course and assignment',assignments:[{id:'1',title:'Assignment 1',dueDate:'2026-10-30'}]};
 const imported=await importCanvasCourses(root,{courses:[course],observedAt:'2026-10-21T14:00:00.000Z'}),path=imported.courses[0].path,snapshotFile=join(root,path.slice(0,-10),'.canvas.json'),bytes=await readFile(snapshotFile),saved=await readContent(root,path);
 await saveContent(root,{path,expectedRevision:saved.revision,fields:{...saved.fields,title:'My probability workspace',next:'Prepare recitation',notes:saved.fields.notes+'\nLocal teaching note.\n'}});
 assert.deepEqual(await readFile(snapshotFile),bytes);
 await importCanvasCourses(root,{courses:[{...course,assignments:[{...course.assignments[0],dueDate:'2026-11-01'}]}],observedAt:'2026-10-22T14:00:00.000Z'});
 const item=(await indexWorkspace(root)).items.courses[0];assert.equal(item.title,'My probability workspace');assert.equal(item.next,'Prepare recitation');assert.match(item.notes,/Local teaching note/);assert.equal(item.canvas.assignments[0].dueDate,'2026-11-01');
});
test('editing local TeX notes keeps prior bytes, while unchanged saves create no history',async t=>{
 const root=await fixture(t),{path}=await createItem(root,{category:'learn',title:'Theory'}),saved=await readContent(root,path);
 await saveContent(root,{path,expectedRevision:saved.revision,fields:saved.fields});await assert.rejects(readdir(join(root,'learn/Theory/.edit-history')),{code:'ENOENT'});
 const note='learn/Theory/notes/proof.tex',original='\\[a=b\\]\r\n';await writeFile(join(root,note),original);
 const data=await readContent(root,note);assert.equal(data.fields,undefined);
 await saveContent(root,{path:note,expectedRevision:data.revision,content:'\\[a=b+c\\]\n'});
 assert.equal(await readFile(join(root,note),'utf8'),'\\[a=b+c\\]\n');
 const folder=join(root,'learn/Theory/notes/.edit-history'),versions=await readdir(folder);assert.equal(await readFile(join(folder,versions[0]),'utf8'),original);
});
test('Windows line endings, a UTF-8 BOM and unknown metadata survive a friendly edit',async t=>{
 const root=await fixture(t),{path}=await createItem(root,{category:'learn',title:'Unicode'});
 const content='\uFEFF---\r\ntitle: "Unicode"\r\nsummary: "Original"\r\ncustom: "preserve"\r\n---\r\n\r\n# Unicode\r\nA derivation.\r\n';await writeFile(join(root,path),content);
 const saved=await readContent(root,path);assert.equal(saved.fields.title,'Unicode');assert.equal(saved.fields.summary,'Original');
 await saveContent(root,{path,expectedRevision:saved.revision,fields:{...saved.fields,next:'Read the next lemma'}});
 const changed=await readFile(join(root,path),'utf8');assert.ok(changed.startsWith('\uFEFF---\r\n'));assert.match(changed,/custom: "preserve"\r\n/);assert.ok(changed.endsWith(saved.fields.notes));
 assert.equal((await indexWorkspace(root)).items.learn[0].next,'Read the next lemma');
});
test('unsafe paths, symlinks, non-text sources and invalid fields never replace originals',async t=>{
 const root=await fixture(t),{path}=await createItem(root,{category:'research',title:'Safe'}),saved=await readContent(root,path);
 for(const value of ['../README.md','research/Safe/../README.md','research/.priorities.json','research/Safe/files/paper.pdf','records/track.json','inbox/note.md'])await assert.rejects(readContent(root,value),{status:403});
 await assert.rejects(saveContent(root,{path,expectedRevision:saved.revision,fields:{...saved.fields,title:'bad\nname'}}),{status:400});
 await assert.rejects(saveContent(root,{path,expectedRevision:saved.revision,fields:{...saved.fields,notes:'x'.repeat(256*1024+1)}}),{status:400});
 assert.equal((await readContent(root,path)).revision,saved.revision);
 await writeFile(join(root,'research/Safe/notes/binary.txt'),Buffer.from([255,0]));await assert.rejects(readContent(root,'research/Safe/notes/binary.txt'),{status:415});
 await symlink(join(root,path),join(root,'research/Safe/notes/link.md'));await assert.rejects(readContent(root,'research/Safe/notes/link.md'),{status:403});
 await symlink(join(root,'research/Safe/notes'),join(root,'research/Safe/files/linked'));await assert.rejects(readContent(root,'research/Safe/files/linked/anything.md'),{status:403});
 await symlink(join(root,'learn'),join(root,'research/Safe/.edit-history'));await assert.rejects(saveContent(root,{path,expectedRevision:saved.revision,fields:{...saved.fields,status:'Active'}}),{status:403});
 assert.equal((await readContent(root,path)).revision,saved.revision);
});
test('content HTTP flow enforces Origin, CSRF, JSON and revisions before updating indexed content',async t=>{
 const root=await fixture(t),{path}=await createItem(root,{category:'learn',title:'Analysis'});let handler;
 const server=http.createServer((req,res)=>handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port,origin='http://127.0.0.1:'+port;
 handler=createRequestHandler({workspace:root,port,daily:{csrf:'content-test'}});t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const saved=await(await fetch(origin+'/api/content?path='+encodeURIComponent(path))).json(),body=JSON.stringify({path,expectedRevision:saved.revision,fields:{...saved.fields,next:'Read chapter 3'}});
 const headers={Origin:origin,'Content-Type':'application/json','X-RUWithMe-CSRF':'content-test'};
 for(const [override,status] of [[{Origin:'https://other.example'},403],[{'X-RUWithMe-CSRF':'bad'},403],[{'Content-Type':'text/plain'},415]])assert.equal((await fetch(origin+'/api/content/save',{method:'POST',headers:{...headers,...override},body})).status,status);
 assert.equal((await fetch(origin+'/api/content/save',{method:'POST',headers,body})).status,200);
 assert.equal((await(await fetch(origin+'/api/workspace')).json()).items.learn[0].next,'Read chapter 3');
 assert.equal((await fetch(origin+'/api/content/save',{method:'POST',headers,body})).status,409);
});
