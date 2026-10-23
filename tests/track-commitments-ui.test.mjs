import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

async function fixture(){
 const listeners=new Map(),posts=[],dialogs=[];
 const cm={id:'cm',kind:'commitment',title:'Send checked manuscript',category:'research',status:'waiting',dueDate:'2026-10-30',ownerPath:'research/Example-Research/README.md',waitingOn:'Collaborator',history:[]};
 const closed={...cm,id:'completed',title:'Previously delivered manuscript',status:'done',completedAt:'2026-10-20T15:00:00Z'},deleted={...cm,id:'deleted',title:'Deleted responsibility',deletedAt:'2026-10-21T15:00:00Z'};
 const snapshot={demo:{scenarioDate:'2026-10-22'},items:{research:[{id:'example-research',title:'Example-Research',path:cm.ownerPath}]},records:{calendar:{timeZone:'America/New_York'},commitments:{revision:7,items:[cm,closed,{id:'todo',kind:'todo',title:'Check appendix',status:'open',parentCommitmentId:cm.id,history:[]}],trash:[deleted]},track:{revision:0,drafts:[],entries:[{id:'plan',date:'2026-10-21',type:'plan',confirmedAt:'2026-10-21T15:00:00Z',timeZone:'America/New_York',content:{priorities:['Check the appendix'],schedule:[],notes:''}}]},sessions:{items:[]},days:[]}};
 const form={elements:{title:{focus(){}},ownerPath:{}},querySelector:()=>({})};
 const document={addEventListener(type,listener){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(listener);},querySelector(selector){return selector==='#commitment-form'?form:null;},querySelectorAll:()=>[]};
 const window={RUSessions:{list:({date})=>`<div data-session-date="${date}"></div>`},RUTodos:{render:()=>'<div data-all-todos></div>',todayCard:()=>'<div data-today-todos></div>'}};
 const context={window,document,Intl,Date,crypto:{randomUUID:()=> 'test-request'},location:{hash:'#track/commitments'}};
 for(const source of await Promise.all(['commitment-ui.js','track-ui.js'].map(name=>readFile(new URL('../app/'+name,import.meta.url),'utf8'))))vm.runInNewContext(source,context);
 let tab='commitments',html='';
 const render=()=>{html=window.RUTrack.render(tab);};
 const api={snapshot:()=>snapshot,active:()=>false,section:()=> 'track',render,notice(){},refresh:async()=>{},dialog:(title,body)=>dialogs.push({title,body}),post:async(path,payload)=>{
  posts.push({path,payload});const store=snapshot.records.commitments;
  assert.equal(payload.expectedRevision,store.revision);
  if(path.endsWith('/delete')){const row=store.items.find(row=>row.id===payload.id);store.items=store.items.filter(row=>row.id!==payload.id);store.trash.push({...row,deletedAt:'2026-10-22T15:00:00Z'});}
  else if(path.endsWith('/restore')){const row=store.trash.find(row=>row.id===payload.id);store.trash=store.trash.filter(row=>row.id!==payload.id);delete row.deletedAt;store.items.push(row);}
  else if(path.endsWith('/status'))store.items.find(row=>row.id===payload.id).status=payload.status;
  else throw new Error('Unexpected API path: '+path);
  store.revision++;
 }};
 window.RUCommitments.init(api);window.RUTrack.init(api);render();
 return{window,snapshot,posts,dialogs,context,get html(){return html;},show(value){tab=value;render();return html;},async click(dataset={},attributes=[]){const button={disabled:false,dataset,hasAttribute:name=>attributes.includes(name)};for(const listener of listeners.get('click')||[])await listener({target:{closest:()=>button}});},async date(value){for(const listener of listeners.get('change')||[])await listener({target:{value,hasAttribute:name=>name==='data-track-date'}});}};
}

test('Track Commitments exposes the full existing manager across dates and all action entry points',async()=>{
 const f=await fixture();
 assert.match(f.html,/<a href="#track\/commitments" aria-current="page">Commitments<\/a>/);
 assert.ok(f.html.includes(f.window.RUCommitments.dashboard()));
 for(const action of ['data-cm-new','data-cm-filter="active"','data-cm-filter="archived"','data-cm-filter="deleted"','data-cm-view="cm"','data-cm-edit="cm"','data-cm-status="cm"','data-cm-delete="cm"','data-todo-parent="cm"'])assert.ok(f.html.includes(action),action);
 assert.ok(f.html.includes('Send checked manuscript'));
 assert.ok(!f.html.includes('data-track-date'));
 assert.ok(!f.html.includes('data-track-start'));
 assert.deepEqual(JSON.parse(JSON.stringify(f.window.RUTrack.context())),{trackTab:'commitments'});
 await f.click({},['data-cm-new']);assert.equal(f.dialogs.at(-1).title,'Add commitment');
 await f.click({cmEdit:'cm'});assert.equal(f.dialogs.at(-1).title,'Edit commitment');
 await f.click({cmView:'cm'});assert.match(f.dialogs.at(-1).body,/Linked actions/);assert.match(f.dialogs.at(-1).body,/Check appendix/);
 assert.equal(f.posts.length,0);
});

test('Track manager keeps archive, delete, restore and status callbacks with shared revision checks',async()=>{
 const f=await fixture();
 await f.click({cmFilter:'archived'});assert.match(f.html,/Previously delivered manuscript/);assert.match(f.html,/data-cm-status="completed"/);assert.ok(!f.html.includes('data-cm-edit="completed"'));
 await f.click({cmFilter:'deleted'});assert.match(f.html,/Deleted responsibility/);assert.match(f.html,/data-cm-restore="deleted"/);
 await f.click({cmRestore:'deleted'});assert.equal(f.posts.at(-1).path,'/api/commitments/restore');assert.equal(f.posts.at(-1).payload.expectedRevision,7);
 await f.click({cmFilter:'active'});assert.match(f.html,/Deleted responsibility/);
 await f.click({cmDelete:'cm'});assert.equal(f.posts.at(-1).path,'/api/commitments/delete');assert.equal(f.posts.at(-1).payload.expectedRevision,8);assert.match(f.html,/Commitment deleted/);
 await f.click({cmRestore:'cm'});assert.equal(f.posts.at(-1).payload.expectedRevision,9);assert.match(f.html,/Send checked manuscript/);
 await f.click({cmStatus:'cm',status:'done'});assert.equal(f.posts.at(-1).path,'/api/commitments/status');assert.equal(f.posts.at(-1).payload.expectedRevision,10);
 await f.click({cmFilter:'archived'});assert.match(f.html,/Send checked manuscript/);
});

test('Commitments navigation preserves Daily, Todos, Weekly and History with the chosen record date',async()=>{
 const f=await fixture();
 assert.match(f.show('records'),/data-today-todos/);
 f.context.location.hash='#track';await f.date('2026-10-21');assert.match(f.html,/Check the appendix/);assert.equal(f.window.RUTrack.context().trackDate,'2026-10-21');
 assert.ok(!f.show('commitments').includes('data-track-date'));assert.equal(f.window.RUTrack.context().trackDate,undefined);
 assert.match(f.show('todos'),/data-all-todos/);assert.equal(f.window.RUTrack.context().trackDate,'2026-10-21');
 assert.match(f.show('weekly'),/Generate weekly review/);assert.equal(f.window.RUTrack.context().trackDate,'2026-10-19');
 assert.match(f.show('history'),/data-track-preview="plan"/);assert.equal(f.window.RUTrack.context().trackDate,'2026-10-21');
 assert.match(f.show('records'),/data-track-date value="2026-10-21"/);assert.match(f.html,/Check the appendix/);
});
