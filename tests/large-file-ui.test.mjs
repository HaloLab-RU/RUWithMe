import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

async function uiFixture(){
 const largePath='research/Example-Study/files/results<&>.csv',inboxPath='inbox/large<&>.pdf';
 const large={path:largePath,name:'results<&>.csv',size:32*1024*1024+1,previewAvailable:false};
 const inbox={path:inboxPath,name:'large<&>.pdf',size:large.size,previewAvailable:false};
 const small={path:'inbox/note.txt',name:'note.txt',size:12,previewAvailable:true};
 const snapshot={revision:'1',records:{calendar:{timeZone:'America/New_York'}},items:{research:[{id:'Example-Study',title:'Example-Study',path:'research/Example-Study/README.md',files:[large]}]},inbox:[inbox,small]};
 const elements=new Map(),requests=[];let daily,content,research;
 const element=()=>({classList:{remove(){},toggle(){}},addEventListener(){},showModal(){this.open=true;},close(){this.open=false;}});
 const document={querySelector(selector){if(!elements.has(selector))elements.set(selector,element());return elements.get(selector);},querySelectorAll:()=>[],createElement:element,body:{append(){}},addEventListener(){}};
 const window={addEventListener(){},scrollTo(){}};
 for(const name of ['RULocalEvents','RUPDF','RUToday','RUWorkspaceMode','RUContent','RUSessions','RUTrack','RUResearch','RUCommitments','RUTodos','RUCalendar','RUDaily'])window[name]={init(){},context:()=>({}),paintReview(){}};
 Object.assign(window.RUToday,{day:()=>'2026-10-22',render:()=>''});
 window.RUContent.init=api=>{content=api;};window.RUResearch.init=api=>{research=api;};
 Object.assign(window.RUDaily,{init:api=>{daily=api;},sync(){}});
 const context={window,document,location:{hash:'#inbox'},setInterval(){},setTimeout(){},clearTimeout(){},fetch:async url=>{
  requests.push(url);
  if(url==='/api/workspace')return{ok:true,json:async()=>snapshot};
  if(url==='/api/file?path='+encodeURIComponent(small.path))return{ok:true,text:async()=>'A small note.'};
  throw new Error('Unexpected request: '+url);
 }};
 vm.runInNewContext(await readFile(new URL('../app/materials-ui.js',import.meta.url),'utf8'),context);
 vm.runInNewContext(await readFile(new URL('../app/app.js',import.meta.url),'utf8'),context);
 await content.refresh();
 return{window,elements,requests,daily,research,large,inbox,small};
}

test('oversized files have a preview-limit label in Inbox and workspace material rows',async()=>{
 const {window,research,large,inbox,small}=await uiFixture();
 for(const html of [research.fileRows([inbox]),window.RUMaterials.rows([large])]){
  assert.ok(html.includes('Preview unavailable · over 32 MiB'));
  assert.ok(html.includes('&lt;&amp;&gt;'));
  assert.ok(!html.includes('<&>'));
 }
 assert.ok(!research.fileRows([small]).includes('Preview unavailable'));
 assert.ok(!window.RUMaterials.rows([{...large,previewAvailable:true}]).includes('Preview unavailable'));
});

test('oversized preview explains the limit without fetching or replacing the last successful preview',async()=>{
 const {elements,requests,daily,large,inbox,small}=await uiFixture();
 await daily.preview(large.path);
 assert.equal(JSON.parse(daily.context()).previewPath,null);
 await daily.preview(small.path);
 assert.equal(JSON.parse(daily.context()).previewPath,small.path);
 const previousRequests=requests.slice();
 for(const file of [large,inbox]){
  await daily.preview(file.path);
  assert.equal(elements.get('#dialog-title').textContent,'Preview unavailable');
  const html=elements.get('#dialog-body').innerHTML;
  assert.ok(html.includes('32 MiB preview limit'));
  assert.ok(html.includes('original remains on disk'));
  assert.ok(html.includes(file.path.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')));
  assert.ok(!html.includes('download='));
  assert.ok(!html.includes('<&>'));
  assert.equal(JSON.parse(daily.context()).previewPath,small.path);
 }
 assert.deepEqual(requests,previousRequests);
});
