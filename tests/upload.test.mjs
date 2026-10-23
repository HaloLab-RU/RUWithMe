import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,mkdir,readFile,readdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {uploadInboxFile,indexWorkspace,MAX_SOURCE_BYTES} from '../app/workspace.mjs';
import {createRequestHandler} from '../app/server.mjs';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'ruwithme-upload-'));
 for(const category of ['research','courses','learn','inbox'])await mkdir(join(root,category));
 t.after(()=>rm(root,{recursive:true,force:true}));return root;
}
async function serverFixture(t){
 const root=await fixture(t);let handler;
 const server=http.createServer((req,res)=>handler(req,res));
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const port=server.address().port,origin='http://127.0.0.1:'+port,csrf='test-upload-csrf';
 // This fake has no model/account methods: upload and preview must not need them.
 handler=createRequestHandler({workspace:root,daily:{csrf},port});
 t.after(()=>new Promise((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections();}));
 const headers={'Origin':origin,'X-RUWithMe-CSRF':csrf,'Content-Type':'application/octet-stream'};
 return{root,origin,port,headers,upload:(name,body,overrides={})=>fetch(origin+'/api/inbox/files?name='+encodeURIComponent(name),{method:'POST',headers:{...headers,...overrides},body})};
}

test('Inbox upload preserves the original Unicode filename and all binary bytes',async t=>{
 const root=await fixture(t),name='随机 推导 1.PDF',body=Buffer.from([0x25,0x50,0x44,0x46,0,128,255,10]);
 const result=await uploadInboxFile(root,name,body);
 assert.deepEqual(result,{path:'inbox/'+name,name,size:body.length,kind:'file',uploadedAt:result.uploadedAt});
 assert.equal(new Date(result.uploadedAt).toISOString(),result.uploadedAt);
 assert.deepEqual(await readFile(join(root,'inbox',name)),body);
 const indexed=await indexWorkspace(root);
 assert.equal(indexed.inbox[0].name,name);
 assert.deepEqual(indexed.counts,{research:0,courses:0,learn:0,career:0,admin:0,personal:0,inbox:1});
});

test('existing files, symlinks and concurrent duplicate uploads cannot be overwritten',async t=>{
 const root=await fixture(t),original=Buffer.from('original');
 await writeFile(join(root,'inbox/paper.pdf'),original);
 await assert.rejects(uploadInboxFile(root,'paper.pdf',Buffer.from('replacement')),e=>e.status===409);
 assert.deepEqual(await readFile(join(root,'inbox/paper.pdf')),original);
 await writeFile(join(root,'research/target.pdf'),original);
 await symlink(join(root,'research/target.pdf'),join(root,'inbox/link.pdf'));
 await assert.rejects(uploadInboxFile(root,'link.pdf',Buffer.from('replacement')),e=>e.status===409);
 assert.deepEqual(await readFile(join(root,'research/target.pdf')),original);
 const bodies=[Buffer.from('one'),Buffer.from('two')];
 const results=await Promise.allSettled(bodies.map(body=>uploadInboxFile(root,'same.pdf',body)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
 const winner=results.findIndex(r=>r.status==='fulfilled');
 assert.deepEqual(await readFile(join(root,'inbox/same.pdf')),bodies[winner]);
});

test('invalid names, unsupported types and oversized content create no files',async t=>{
 const root=await fixture(t);
 for(const name of [null,'','.hidden.md','../outside.md','nested/a.md','nested\\a.md','a\0.md','a\n.md','a\u007f.md','a'.repeat(252)+'.pdf']){
  await assert.rejects(uploadInboxFile(root,name,Buffer.from('x')),e=>e.status===400);
 }
 await assert.rejects(uploadInboxFile(root,'program.exe',Buffer.from('x')),e=>e.status===415);
 await assert.rejects(uploadInboxFile(root,'too-big.pdf',Buffer.alloc(MAX_SOURCE_BYTES+1)),e=>e.status===413);
 assert.deepEqual(await readdir(join(root,'inbox')),[]);
});

test('Inbox symlink redirection is rejected even to another workspace folder',async t=>{
 const root=await fixture(t),outside=await mkdtemp(join(tmpdir(),'ruwithme-upload-outside-'));
 t.after(()=>rm(outside,{recursive:true,force:true}));
 await rm(join(root,'inbox'),{recursive:true});
 for(const destination of [join(root,'research'),outside]){
  await symlink(destination,join(root,'inbox'));
  await assert.rejects(uploadInboxFile(root,'paper.pdf',Buffer.from('x')),e=>e.status===403);
  assert.deepEqual(await readdir(destination),[]);
  await rm(join(root,'inbox'));
 }
});

test('HTTP upload, index and preview round-trip a local original without a model',async t=>{
 const {root,origin,upload}=await serverFixture(t),name='课程 notes #1.pdf',body=Buffer.from([0,1,127,128,254,255]);
 const response=await upload(name,body);
 assert.equal(response.status,201);
 const saved=await response.json();
 assert.deepEqual(saved,{path:'inbox/'+name,name,size:body.length,kind:'file',uploadedAt:saved.uploadedAt});
 assert.equal(new Date(saved.uploadedAt).toISOString(),saved.uploadedAt);
 assert.deepEqual(await readFile(join(root,'inbox',name)),body);
 const preview=await fetch(origin+'/api/file?path='+encodeURIComponent('inbox/'+name));
 assert.equal(preview.status,200);assert.equal(preview.headers.get('content-type'),'application/pdf');
 assert.deepEqual(Buffer.from(await preview.arrayBuffer()),body);
 const indexed=await(await fetch(origin+'/api/workspace')).json();
 assert.equal(indexed.inbox[0].path,'inbox/'+name);
 const duplicate=await upload(name,Buffer.from('changed'));
 assert.equal(duplicate.status,409);await duplicate.json();
 assert.deepEqual(await readFile(join(root,'inbox',name)),body);
});

test('HTTP writes require exact local origin, CSRF token, binary content type and POST',async t=>{
 const {root,origin,port,headers,upload}=await serverFixture(t);
 for(const override of [{Origin:''},{Origin:'https://example.com'},{'X-RUWithMe-CSRF':''},{'X-RUWithMe-CSRF':'wrong'},{'Sec-Fetch-Site':'cross-site'}]){
  const response=await upload('blocked.pdf',Buffer.from('x'),override);
  assert.equal(response.status,403,JSON.stringify(override));await response.json();
 }
 const type=await upload('blocked.pdf',Buffer.from('x'),{'Content-Type':'text/plain'});
 assert.equal(type.status,415);await type.json();
 const method=await fetch(origin+'/api/inbox/files?name=blocked.pdf',{headers});
 assert.equal(method.status,405);await method.json();
 const path=await upload('../blocked.pdf',Buffer.from('x'));
 assert.equal(path.status,400);await path.json();
 const invalidHost=await new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port,agent:false,path:'/api/inbox/files?name=blocked.pdf',method:'POST',headers:{...headers,Host:'example.com:'+port}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
  req.on('error',reject);req.end(Buffer.from('x'));
 });
 assert.equal(invalidHost,403);
 assert.deepEqual(await readdir(join(root,'inbox')),[]);
});

test('HTTP rejects declared and chunked oversized uploads before any file is created',async t=>{
 const {root,port,headers}=await serverFixture(t);
 async function send({declared=false}){
  return new Promise((resolve,reject)=>{
   const req=http.request({hostname:'127.0.0.1',port,agent:false,path:'/api/inbox/files?name=large.pdf',method:'POST',headers:{...headers,...(declared?{'Content-Length':String(MAX_SOURCE_BYTES+1)}:{'Transfer-Encoding':'chunked'})}},res=>{
    let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body}));
   });
   req.on('error',reject);
   if(declared)req.end();
   else{const chunk=Buffer.alloc(64*1024);for(let i=0;i<512;i++)req.write(chunk);req.end(Buffer.from('x'));}
  });
 }
 for(const declared of [true,false]){
  const response=await send({declared});assert.equal(response.status,413);
  assert.equal(JSON.parse(response.body).error,'Upload supports files up to 32 MB.');
 }
 assert.deepEqual(await readdir(join(root,'inbox')),[]);
});
