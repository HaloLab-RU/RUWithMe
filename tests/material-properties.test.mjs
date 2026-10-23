import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile,symlink,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {buildDemo} from '../scripts/seed-demo.mjs';
import {indexWorkspace} from '../app/workspace.mjs';
import {readMaterialProperties,getMaterialProperties,saveMaterialProperties} from '../app/material-properties.mjs';
import {createRequestHandler} from '../app/server.mjs';
import vm from 'node:vm';
import {buildDailyContext} from '../app/daily-context.mjs';

async function fixture(t){const root=await mkdtemp(join(tmpdir(),'ruwithme-file-properties-'));t.after(()=>rm(root,{recursive:true,force:true}));const data=await buildDemo(root);return{root,data,path:data.items.research.find(row=>row.files.some(file=>file.name.endsWith('.pdf'))).files.find(file=>file.name.endsWith('.pdf')).path};}
const values={summary:'Working note about the weight-bound assumption.',priority:'high',properties:[{name:'Topic',value:'Distribution shift'},{name:'Reading status',value:'To discuss'}]};
test('properties persist independently, refresh the index, and can be cleared without changing original bytes or work records',async t=>{
 const {root,path}=await fixture(t),before=await readFile(join(root,path)),tasks=await readFile(join(root,'records/commitments.json')),start=await indexWorkspace(root);
 assert.deepEqual(await readMaterialProperties(root),{version:1,revision:0,items:[]});assert.ok(!(await readdir(root)).includes('.material-properties.json'));
 const first=await saveMaterialProperties(root,{path,expectedRevision:0,...values});assert.equal(first.revision,1);
 assert.deepEqual(await getMaterialProperties(root,path),first);assert.deepEqual(await readFile(join(root,path)),before);assert.deepEqual(await readFile(join(root,'records/commitments.json')),tasks);
 const updated=await indexWorkspace(root);assert.notEqual(updated.revision,start.revision);assert.deepEqual(updated.items.research.flatMap(row=>row.files).find(file=>file.path===path).materialProperties,first);
 const owner=updated.items.research.find(row=>row.files.some(file=>file.path===path)),context=await buildDailyContext({workspaceRoot:root,context:JSON.stringify({section:'research',sourcePath:owner.path})});assert.ok(context.includes(values.summary));
 const second=await saveMaterialProperties(root,{path,expectedRevision:1,summary:'',priority:'',properties:[]});assert.equal(second.revision,2);assert.equal((await getMaterialProperties(root,path)).summary,'');assert.deepEqual(await readFile(join(root,path)),before);
});
test('stale writes conflict, concurrent writes keep one winner, and unrelated files have independent revisions',async t=>{
 const {root,data,path}=await fixture(t),other=data.items.learn[0].files[0].path;
 const writes=await Promise.allSettled([saveMaterialProperties(root,{path,expectedRevision:0,...values}),saveMaterialProperties(root,{path,expectedRevision:0,...values,summary:'Different draft'})]);
 assert.equal(writes.filter(row=>row.status==='fulfilled').length,1);assert.equal(writes.find(row=>row.status==='rejected').reason.status,409);
 const before=await readFile(join(root,'.material-properties.json'));await assert.rejects(saveMaterialProperties(root,{path,expectedRevision:0,...values}),{status:409});assert.deepEqual(await readFile(join(root,'.material-properties.json')),before);
 await saveMaterialProperties(root,{path:other,expectedRevision:0,...values});assert.equal((await getMaterialProperties(root,path)).revision,1);assert.equal((await getMaterialProperties(root,other)).revision,1);
});
test('invalid properties, corrupt stores, traversal and symbolic links preserve existing data',async t=>{
 const {root,path}=await fixture(t);
 for(const extra of [{summary:'a'.repeat(601)},{priority:'p1'},{properties:[{name:'Topic',value:'A'},{name:'topic',value:'B'}]},{properties:[{name:'priority',value:'A'}]},{properties:[{name:'',value:'A'}]}])await assert.rejects(saveMaterialProperties(root,{path,expectedRevision:0,...values,...extra}),{status:400});
 for(const bad of ['../outside.md','inbox/source.md','research/../files/note.md','research/Test/README.md'])await assert.rejects(saveMaterialProperties(root,{path:bad,expectedRevision:0,...values}),{status:400});
 const target=join(root,'research/Linked');await mkdir(target);await symlink(join(root,path),join(target,'alias.pdf'));await assert.rejects(saveMaterialProperties(root,{path:'research/Linked/alias.pdf',expectedRevision:0,...values}),{status:403});
 const store=join(root,'.material-properties.json');await writeFile(store,'{broken');await assert.rejects(saveMaterialProperties(root,{path,expectedRevision:0,...values}),{status:422});assert.equal(await readFile(store,'utf8'),'{broken');
 await rm(store);const outside=join(root,'outside.json');await writeFile(outside,'unchanged');await symlink(outside,store);await assert.rejects(saveMaterialProperties(root,{path,expectedRevision:0,...values}),{status:403});assert.equal(await readFile(outside,'utf8'),'unchanged');
});
test('HTTP editing checks origin/CSRF and revision, then returns the saved properties through the workspace',async t=>{
 const {root,path}=await fixture(t);let handler;const server=http.createServer((req,res)=>handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port,origin='http://127.0.0.1:'+port;handler=createRequestHandler({workspace:root,port,daily:{csrf:'test-only'}});t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const url=origin+'/api/materials/properties/save',body=JSON.stringify({path,expectedRevision:0,...values}),headers={Origin:origin,'Content-Type':'application/json','X-RUWithMe-CSRF':'test-only'};
 assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body})).status,403);
 assert.equal((await fetch(url,{method:'POST',headers:{...headers,Origin:'https://elsewhere.example'},body})).status,403);
 const response=await fetch(url,{method:'POST',headers,body});assert.equal(response.status,200);const saved=await response.json();assert.equal(saved.priority,'high');
 assert.equal((await fetch(url,{method:'POST',headers,body})).status,409);
 const result=await fetch(origin+'/api/materials/properties?'+new URLSearchParams({path}));assert.deepEqual(await result.json(),saved);
 assert.equal((await fetch(url,{method:'POST',headers,body:'null'})).status,400);
});
test('material rows escape user-authored summaries and custom properties while keeping original-file preview actions',async()=>{
 const context={window:{},document:{createElement:()=>({addEventListener(){}}),body:{append(){}},addEventListener(){}}};vm.runInNewContext(await readFile(new URL('../app/materials-ui.js',import.meta.url),'utf8'),context);
 const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');context.window.RUMaterials.init({escape});
 const html=context.window.RUMaterials.rows([{path:'research/Test/files/paper.pdf',name:'paper.pdf',size:100,materialProperties:{summary:'<img src=x>',priority:'high',properties:[{name:'<Topic>',value:'"Value"'}]}}]);
 assert.match(html,/&lt;img src=x&gt;/);assert.match(html,/&lt;Topic&gt;/);assert.ok(!html.includes('<img'));assert.match(html,/data-file="research\/Test\/files\/paper.pdf"/);assert.match(html,/aria-label="Notes and files" tabindex="0"/);
});
