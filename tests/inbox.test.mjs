import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,readdir,writeFile,symlink,link,rm,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {uploadInboxFile,renameInboxFile,createInboxLink,indexWorkspace,safeFile} from '../app/workspace.mjs';
import {createRequestHandler} from '../app/server.mjs';
const executeFile=promisify(execFile);

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'ruwithme-inbox-'));
 for(const category of ['research','courses','learn','inbox'])await mkdir(join(root,category));
 t.after(()=>rm(root,{recursive:true,force:true}));return root;
}
async function serverFixture(t){
 const root=await fixture(t);let handler;
 const server=http.createServer((req,res)=>handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');
 const port=server.address().port,origin='http://127.0.0.1:'+port,headers={Origin:origin,'X-RUWithMe-CSRF':'inbox-test','Content-Type':'application/json'};
 handler=createRequestHandler({workspace:root,port,daily:{csrf:'inbox-test'}});
 t.after(()=>new Promise((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections();}));
 return{root,origin,post:(path,data,overrides={})=>fetch(origin+path,{method:'POST',headers:{...headers,...overrides},body:JSON.stringify(data)})};
}

test('upload time survives file rename and a fresh Node process; legacy times stay unknown',async t=>{
 const root=await fixture(t),body=Buffer.from([0,128,255]),saved=await uploadInboxFile(root,'原始 paper.pdf',body);
 await writeFile(join(root,'inbox/legacy.pdf'),'legacy');
 await utimes(join(root,'inbox/legacy.pdf'),new Date('2001-01-01'),new Date('2001-01-01'));
 const renamed=await renameInboxFile(root,{path:saved.path,name:'新名字.pdf'});
 assert.equal(renamed.uploadedAt,saved.uploadedAt);
 assert.deepEqual(await readFile(join(root,renamed.path)),body);
 await renameInboxFile(root,{path:'inbox/legacy.pdf',name:'old-file.pdf'});
 const code='const {indexWorkspace}=await import(process.argv[1]);process.stdout.write(JSON.stringify(await indexWorkspace(process.argv[2])));';
 const {stdout}=await executeFile(process.execPath,['--input-type=module','-e',code,new URL('../app/workspace.mjs',import.meta.url).href,root]);
 const restarted=JSON.parse(stdout);
 assert.equal(restarted.inbox.find(f=>f.name==='新名字.pdf').uploadedAt,saved.uploadedAt);
 assert.equal(restarted.inbox.find(f=>f.name==='old-file.pdf').uploadedAt,null);
 assert.equal(restarted.inbox.length,2);
 const sidecar=JSON.parse(await readFile(join(root,'inbox/.metadata.json'),'utf8'));
 assert.deepEqual(Object.keys(sidecar.files),['新名字.pdf']);
 await assert.rejects(safeFile(root,'inbox/.metadata.json'),e=>e.status===403);
});

test('rename never overwrites a destination, changes an extension or follows source links',async t=>{
 const root=await fixture(t),saved=await uploadInboxFile(root,'source.pdf',Buffer.from('source'));
 await writeFile(join(root,'inbox/existing.pdf'),'existing');
 await symlink(join(root,'inbox/source.pdf'),join(root,'inbox/linked.pdf'));
 await link(join(root,'inbox/source.pdf'),join(root,'inbox/alias.pdf'));
 const before=await readFile(join(root,'inbox/.metadata.json'),'utf8');
 assert.deepEqual(await renameInboxFile(root,{path:saved.path,name:saved.name}),{path:saved.path,name:saved.name,kind:'file',uploadedAt:saved.uploadedAt});
 for(const name of ['existing.pdf','alias.pdf','linked.pdf','SOURCE.pdf'])await assert.rejects(renameInboxFile(root,{path:saved.path,name}),e=>e.status===409);
 for(const request of [{path:saved.path,name:'changed.txt'},{path:'research/source.pdf',name:'renamed.pdf'},{path:'inbox/nested/source.pdf',name:'renamed.pdf'},{path:saved.path,name:'../renamed.pdf'},{path:saved.path,name:'.hidden.pdf'}])await assert.rejects(renameInboxFile(root,request),e=>e.status===400);
 await assert.rejects(renameInboxFile(root,{path:'inbox/linked.pdf',name:'new.pdf'}),e=>e.status===403);
 assert.equal(await readFile(join(root,'inbox/source.pdf'),'utf8'),'source');
 assert.equal(await readFile(join(root,'inbox/existing.pdf'),'utf8'),'existing');
 assert.equal(await readFile(join(root,'inbox/.metadata.json'),'utf8'),before);
});

test('websites are portable literal JSON documents with validated URLs and explicit added time',async t=>{
 const root=await fixture(t),title='论文 <script>alert("x")</script> & 引用',saved=await createInboxLink(root,{url:'https://example.com/a?q=%22test%22#part',title});
 assert.equal(saved.kind,'link');assert.equal(saved.title,title);assert.equal(saved.uploadedAt,null);
 assert.equal(new Date(saved.addedAt).toISOString(),saved.addedAt);
 assert.match(saved.name,/\.link\.json$/);assert.ok(Buffer.byteLength(saved.name)<=255);assert.ok(!saved.name.includes('/'));
 const record=JSON.parse(await readFile(join(root,saved.path),'utf8'));
 assert.deepEqual(record,{type:'ruwithme-link',version:1,title,url:saved.url,addedAt:saved.addedAt});
 const indexed=(await indexWorkspace(root)).inbox[0];
 assert.equal(indexed.kind,'link');assert.equal(indexed.title,title);assert.equal(indexed.url,saved.url);assert.equal(indexed.addedAt,saved.addedAt);
 await assert.rejects(createInboxLink(root,{url:saved.url,title}),e=>e.status===409);
 assert.deepEqual(JSON.parse(await readFile(join(root,saved.path),'utf8')),record);
 const fallback=await createInboxLink(root,{url:'https://www.example.org/docs'});
 assert.equal(fallback.title,'www.example.org');assert.equal(fallback.name,'www.example.org.link.json');
 const long=await createInboxLink(root,{url:'https://example.net/',title:'研'.repeat(200)});
 assert.ok(Buffer.byteLength(long.name)<=255);assert.ok(!long.name.includes('\ufffd'));
});

test('unsafe URLs are rejected without creating content; invalid portable records remain plain files',async t=>{
 const root=await fixture(t);
 for(const url of ['',null,'not a URL','/relative','javascript:alert(1)','data:text/html,hello','file:///etc/passwd','ftp://example.com','https://user:pass@example.com/','https://user@example.com','https://example.com/\npath'])await assert.rejects(createInboxLink(root,{url}),e=>e.status===400);
 assert.deepEqual(await readdir(join(root,'inbox')),[]);
 const valid={type:'ruwithme-link',version:1,title:'Title',url:'https://example.com',addedAt:new Date().toISOString()};
 const variants=[{...valid,url:'javascript:alert(1)'},{...valid,version:2},{...valid,type:'other'},{...valid,addedAt:'yesterday'},{...valid,title:''},{...valid,url:'https://user:password@example.com'}];
 for(let i=0;i<variants.length;i++)await writeFile(join(root,'inbox/record-'+i+'.link.json'),JSON.stringify(variants[i]));
 await writeFile(join(root,'inbox/broken.link.json'),'{broken');
 const indexed=await indexWorkspace(root);
 assert.equal(indexed.inbox.length,variants.length+1);
 for(const entry of indexed.inbox){assert.equal(entry.kind,'file');assert.equal(entry.uploadedAt,null);assert.equal(entry.url,undefined);}
});

test('renaming a link updates its title and keeps URL, added time and compound suffix',async t=>{
 const root=await fixture(t),saved=await createInboxLink(root,{url:'https://example.com/?a=1&b=2',title:'Old title'});
 await assert.rejects(renameInboxFile(root,{path:saved.path,name:'plain.json'}),e=>e.status===400);
 const result=await renameInboxFile(root,{path:saved.path,name:'新标题.link.json'});
 assert.equal(result.title,'新标题');assert.equal(result.url,saved.url);assert.equal(result.addedAt,saved.addedAt);assert.equal(result.uploadedAt,null);
 const record=JSON.parse(await readFile(join(root,result.path),'utf8'));
 assert.equal(record.title,'新标题');assert.equal(record.addedAt,saved.addedAt);
 await assert.rejects(readFile(join(root,saved.path)),e=>e.code==='ENOENT');
 const row=(await indexWorkspace(root)).inbox[0];assert.equal(row.title,'新标题');assert.equal(row.addedAt,saved.addedAt);
});

test('serialized uploads, link creation and rename preserve every metadata update',async t=>{
 const root=await fixture(t),first=await uploadInboxFile(root,'first.pdf',Buffer.from('one'));
 const [second,website,renamed]=await Promise.all([
  uploadInboxFile(root,'second.pdf',Buffer.from('two')),
  createInboxLink(root,{url:'https://example.com',title:'A link'}),
  renameInboxFile(root,{path:first.path,name:'renamed.pdf'})
 ]);
 const data=await indexWorkspace(root),rows=new Map(data.inbox.map(row=>[row.path,row]));
 assert.equal(data.inbox.length,3);
 assert.equal(rows.get(second.path).uploadedAt,second.uploadedAt);
 assert.equal(rows.get(renamed.path).uploadedAt,first.uploadedAt);
 assert.equal(rows.get(website.path).addedAt,website.addedAt);
 const sidecar=JSON.parse(await readFile(join(root,'inbox/.metadata.json'),'utf8'));
 assert.deepEqual(Object.keys(sidecar.files).sort(),['renamed.pdf','second.pdf']);
 assert.ok(!(await readdir(join(root,'inbox'))).some(name=>name.endsWith('.tmp')));
});

test('corrupt or redirected metadata blocks mutations without touching original sources',async t=>{
 const root=await fixture(t),saved=await uploadInboxFile(root,'source.pdf',Buffer.from('original'));
 const sidecar=join(root,'inbox/.metadata.json'),valid=await readFile(sidecar,'utf8'),outside=join(root,'research/metadata.json');
 await writeFile(outside,'sensitive original');await rm(sidecar);await symlink(outside,sidecar);
 for(const operation of [()=>uploadInboxFile(root,'new.pdf',Buffer.from('new')),()=>createInboxLink(root,{url:'https://example.com'}),()=>renameInboxFile(root,{path:saved.path,name:'renamed.pdf'})])await assert.rejects(operation,e=>e.status===403);
 assert.equal(await readFile(outside,'utf8'),'sensitive original');
 await rm(sidecar);await writeFile(sidecar,'{broken');
 await assert.rejects(uploadInboxFile(root,'new.pdf',Buffer.from('new')),e=>e.status===422);
 assert.equal(await readFile(sidecar,'utf8'),'{broken');
 assert.equal(await readFile(join(root,saved.path),'utf8'),'original');
 await writeFile(sidecar,valid);
 assert.equal((await indexWorkspace(root)).inbox[0].uploadedAt,saved.uploadedAt);
});

test('HTTP link and rename endpoints enforce origin/CSRF and return persisted Inbox data',async t=>{
 const {root,origin,post}=await serverFixture(t);
 for(const path of ['/api/inbox/links','/api/inbox/rename']){
  for(const override of [{Origin:'https://example.com'},{Origin:''},{'X-RUWithMe-CSRF':'wrong'}]){
   const blocked=await post(path,{url:'https://example.com'},override);assert.equal(blocked.status,403);await blocked.json();
  }
  const method=await fetch(origin+path);assert.equal(method.status,405);await method.json();
 }
 assert.deepEqual(await readdir(join(root,'inbox')),[]);
 const response=await post('/api/inbox/links',{url:'https://example.com/?q=1&x=2',title:'A < B'});assert.equal(response.status,201);
 const saved=await response.json(),renamed=await post('/api/inbox/rename',{path:saved.path,name:'Renamed.link.json'});assert.equal(renamed.status,200);
 const result=await renamed.json();assert.equal(result.title,'Renamed');assert.equal(result.addedAt,saved.addedAt);
 const data=await(await fetch(origin+'/api/workspace')).json();assert.equal(data.inbox[0].url,saved.url);
 const metadata=await fetch(origin+'/api/file?path='+encodeURIComponent('inbox/.metadata.json'));assert.equal(metadata.status,403);await metadata.json();
 const unsafe=await post('/api/inbox/links',{url:'https://user:secret@example.com'});assert.equal(unsafe.status,400);await unsafe.json();
});
