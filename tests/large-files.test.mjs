import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,mkdir,open,readFile,writeFile,stat,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createItem,createInboxLink,indexWorkspace,safeFile,MAX_SOURCE_BYTES} from '../app/workspace.mjs';
import {createRequestHandler} from '../app/server.mjs';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'ruwithme-large-files-'));
 for(const category of ['research','courses','learn','inbox'])await mkdir(join(root,category));
 t.after(()=>rm(root,{recursive:true,force:true}));return root;
}
async function sparse(root,path,{size=MAX_SOURCE_BYTES+1,prefix=''}={}){
 const handle=await open(join(root,path),'wx');
 try{if(prefix)await handle.writeFile(prefix);await handle.truncate(size);}finally{await handle.close();}
 return await stat(join(root,path));
}
async function serverFixture(t){
 const root=await fixture(t);let handler;
 const server=http.createServer((req,res)=>handler(req,res));
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const port=server.address().port,origin='http://127.0.0.1:'+port;
 handler=createRequestHandler({workspace:root,port,daily:{csrf:'large-files-test'}});
 t.after(()=>new Promise((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections();}));
 return{root,origin};
}

test('large imported files remain indexed with their metadata while small project notes remain usable',async t=>{
 const root=await fixture(t),project=await createItem(root,{category:'research',title:'Example-Study'}),folder=project.path.slice(0,-10);
 const readme=await readFile(join(root,project.path));
 await writeFile(join(root,folder,'notes/proof.md'),'# A proof\n\nCheck the bound.\n');
 const csvPath=folder+'/files/experiments.csv',csv=await sparse(root,csvPath);
 const inboxPath='inbox/large-paper.pdf',paper=await sparse(root,inboxPath);
 const boundaryPath=folder+'/files/preview-boundary.csv';await sparse(root,boundaryPath,{size:MAX_SOURCE_BYTES});
 const indexed=await indexWorkspace(root),item=indexed.items.research[0];
 assert.equal(item.path,project.path);assert.equal(item.title,'Example-Study');assert.equal(indexed.counts.research,1);assert.equal(indexed.counts.inbox,1);
 const large=item.files.find(file=>file.path===csvPath);
 assert.equal(large.name,'experiments.csv');assert.equal(large.size,csv.size);assert.equal(large.modified,csv.mtimeMs);assert.equal(large.kind,'file');assert.equal(large.previewAvailable,false);
 const inbox=indexed.inbox.find(file=>file.path===inboxPath);
 assert.equal(inbox.size,paper.size);assert.equal(inbox.previewAvailable,false);
 assert.equal(item.files.find(file=>file.path.endsWith('/notes/proof.md')).previewAvailable,true);
 assert.equal(item.files.find(file=>file.path===boundaryPath).previewAvailable,true);
 assert.equal((await safeFile(root,boundaryPath)).info.size,MAX_SOURCE_BYTES);
 for(const path of [csvPath,inboxPath])await assert.rejects(safeFile(root,path),{status:413});
 assert.deepEqual(await readFile(join(root,project.path)),readme);
 assert.equal((await stat(join(root,csvPath))).mtimeMs,csv.mtimeMs);
});

test('oversized canonical README and link JSON do not abort or become parsed workspace content',async t=>{
 const root=await fixture(t),project=await createItem(root,{category:'learn',title:'A normal topic'});
 await mkdir(join(root,'research/Oversized'));
 // Parsing this unfinished frontmatter would fail the entire workspace refresh.
 await sparse(root,'research/Oversized/README.md',{prefix:'---\ntitle: "Do not parse this oversized README"\n'});
 const linkPath='inbox/oversized.link.json';await sparse(root,linkPath,{prefix:'{"type":"ruwithme-link","version":1,'});
 const savedLink=await createInboxLink(root,{title:'Working paper',url:'https://example.com/paper'});
 const indexed=await indexWorkspace(root);
 assert.deepEqual(indexed.items.research,[]);assert.equal(indexed.items.learn[0].path,project.path);
 const oversized=indexed.inbox.find(file=>file.path===linkPath);
 assert.equal(oversized.kind,'file');assert.equal(oversized.previewAvailable,false);assert.equal(oversized.url,undefined);
 assert.equal(indexed.inbox.find(file=>file.path===savedLink.path).kind,'link');
});

test('a project archive with more than 2,000 assets is indexed completely alongside smaller projects',async t=>{
 const root=await fixture(t),archive=await createItem(root,{category:'research',title:'Large archive'}),folder=archive.path.slice(0,-10);
 const sibling=await createItem(root,{category:'research',title:'A normal project'}),notePath=sibling.path.slice(0,-10)+'/notes/next.md';
 await writeFile(join(root,notePath),'# Next\n\nReview the argument.\n');
 const paths=Array.from({length:2001},(_,index)=>folder+'/files/result-'+String(index).padStart(4,'0')+'.txt');
 // Keep filesystem work bounded while reproducing a complete imported archive.
 for(let start=0;start<paths.length;start+=32)await Promise.all(paths.slice(start,start+32).map(path=>writeFile(join(root,path),'')));
 const indexed=await indexWorkspace(root),large=indexed.items.research.find(item=>item.path===archive.path),small=indexed.items.research.find(item=>item.path===sibling.path);
 assert.equal(indexed.counts.research,2);
 assert.deepEqual(large.files.map(file=>file.path),paths);
 assert.ok(large.files.every(file=>file.size===0&&file.previewAvailable));
 assert.deepEqual(small.files.map(file=>file.path),[notePath]);
 assert.equal((await safeFile(root,paths.at(-1))).info.size,0);
});

test('metadata indexing still skips hidden files and symlinks and rejects redirected content spaces',async t=>{
 const root=await fixture(t),outside=await mkdtemp(join(tmpdir(),'ruwithme-large-outside-'));
 t.after(()=>rm(outside,{recursive:true,force:true}));
 await sparse(root,'inbox/.private.csv');await writeFile(join(outside,'external.csv'),'private');
 await symlink(join(outside,'external.csv'),join(root,'inbox/external.csv'));
 await symlink(outside,join(root,'inbox/redirected'));
 const indexed=await indexWorkspace(root);assert.deepEqual(indexed.inbox,[]);
 for(const path of ['inbox/.private.csv','inbox/external.csv','inbox/../learn/README.md'])await assert.rejects(safeFile(root,path),{status:403});
 await symlink(join(root,'learn'),join(root,'career'));
 await assert.rejects(indexWorkspace(root),{status:403});
});

test('HTTP workspace refresh succeeds with a large imported file while its preview remains limited',async t=>{
 const {root,origin}=await serverFixture(t),project=await createItem(root,{category:'research',title:'Example-Study'}),folder=project.path.slice(0,-10),path=folder+'/files/results.csv';
 await sparse(root,path);await writeFile(join(root,'inbox/note.txt'),'A small note.');
 const response=await fetch(origin+'/api/workspace');assert.equal(response.status,200);
 const indexed=await response.json(),file=indexed.items.research[0].files.find(file=>file.path===path);
 assert.equal(file.size,MAX_SOURCE_BYTES+1);assert.equal(file.previewAvailable,false);
 const preview=await fetch(origin+'/api/file?path='+encodeURIComponent(path));
 assert.equal(preview.status,413);assert.equal((await preview.json()).error,'Preview supports files up to 32 MB.');
 const note=await fetch(origin+'/api/file?path='+encodeURIComponent('inbox/note.txt'));
 assert.equal(note.status,200);assert.equal(await note.text(),'A small note.');
 const refreshed=await fetch(origin+'/api/workspace');assert.equal(refreshed.status,200);
 assert.equal((await refreshed.json()).items.research[0].path,project.path);
});
