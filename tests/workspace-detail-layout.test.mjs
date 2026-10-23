import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const course={id:'course',path:'courses/Fall-2026/Regression-Lab/README.md',title:'Regression Lab',semester:'Fall 2026',courseRole:'ta',summary:'TA preparation and grading.',status:'Active',next:'Review an absence note.',notes:'Local course notes',files:[{path:'courses/Fall-2026/Regression-Lab/files/handout.pdf'}]};
const research={id:'research',path:'research/Frontier/README.md',title:'Frontier',summary:'Which allocations are efficient?',status:'In progress',priority:'p1',next:'Check the boundary case.',files:[]};
const commitments=[
 {id:'action',kind:'todo',ownerPath:course.path,title:'Draft absence note',status:'open',dueDate:'2026-10-23'},
 {id:'deliverable',kind:'commitment',ownerPath:course.path,title:'Submit grading',status:'waiting',dueDate:'2026-10-25'},
 {id:'completed',kind:'todo',ownerPath:course.path,title:'Completed old task',status:'done'},
 {id:'other',kind:'todo',ownerPath:research.path,title:'Other project task',status:'open'}
];

async function fixture(hash,overrides={}){
 const elements=new Map(),events={},nextCalls=[];let content;
 const element=()=>({classList:{remove(){},toggle(){}},addEventListener(){},showModal(){this.open=true;},close(){this.open=false;}});
 const document={querySelector(selector){if(!elements.has(selector))elements.set(selector,element());return elements.get(selector);},querySelectorAll:()=>[],createElement:element,body:{append(){}},addEventListener(){}};
 const window={addEventListener:(type,callback)=>{events[type]=callback;},scrollTo(){}};
 for(const name of ['RULocalEvents','RUPDF','RUToday','RUWorkspaceMode','RUContent','RUSessions','RUTrack','RUResearch','RUCommitments','RUTodos','RUCalendar','RUDaily','RUMaterials'])window[name]={init(){},context:()=>'',paintReview(){}};
 Object.assign(window.RUToday,{day:()=>'2026-10-23',resume:()=>'<article>Continue from here</article>'});
 window.RUWorkspaceMode.context=()=>'<section><h2>Current context</h2></section>';
 Object.assign(window.RUSessions,{nextStep(item){nextCalls.push(item.path);return `<section class="detail-block"><h2>Next step</h2><p>${escape(item.next)}</p></section>`;},list:()=>'<section><h2>Work sessions</h2></section>'});
 window.RUMaterials.rows=()=>'<div>Course handout</div>';
 window.RUContent.init=api=>{content=api;};
 Object.assign(window.RUDaily,{helpers:{renderMarkdown:escape},sync(){}});
 const snapshot={revision:'detail-fixture',records:{calendar:{timeZone:'America/New_York'},commitments:{items:commitments}},research:{revision:1},items:{research:[research],courses:[{...course,...overrides}],learn:[],career:[],admin:[],personal:[]},inbox:[]};
 const context={window,document,location:{hash},queueMicrotask,setInterval(){},setTimeout(){},clearTimeout(){},fetch:async()=>({ok:true,json:async()=>snapshot})};
 vm.runInNewContext(await readFile(new URL('../app/research-ui.js',import.meta.url),'utf8'),context);
 vm.runInNewContext(await readFile(new URL('../app/app.js',import.meta.url),'utf8'),context);
 await content.refresh();
 return {html:elements.get('#page').innerHTML,nextCalls};
}

function assertOrder(html,labels){
 let previous=-1;
 for(const label of labels){const position=html.indexOf(label);assert.ok(position>previous,`${label} follows the preceding section`);previous=position;}
}

test('course and research detail share the same reading order and canonical Next step renderer',async()=>{
 const c=await fixture('#courses/course'),r=await fixture('#research/research');
 for(const {html} of [c,r]){
  assert.match(html,/workspace-detail-back/);
  assert.match(html,/workspace-detail-header/);
  assert.match(html,/workspace-detail-meta/);
  assert.match(html,/workspace-detail-summary/);
  assert.match(html,/workspace-detail-files/);
  assertOrder(html,['Next step','Continue from here','Current context','Workspace notes','Work sessions','Notes & files']);
 }
 assert.ok(c.nextCalls.includes(course.path));assert.ok(r.nextCalls.includes(research.path));
 assertOrder(c.html,['Course focus','Next step','Workspace notes','My course work','Work sessions','Notes & files']);
 assertOrder(r.html,['Research question','Next step','Workspace notes','Linked todos','Work sessions','Notes & files']);
});

test('course detail preserves the semester, role, status, local ownership and linked work',async()=>{
 const {html}=await fixture('#courses/course');
 assert.match(html,/Semester<\/span><span class="workspace-detail-status">Fall 2026/);
 assert.match(html,/My role<\/span><span class="workspace-detail-status">Teaching assistant/);
 assert.match(html,/Workspace status<\/span><span class="workspace-detail-status">Active/);
 assert.match(html,/Maintained by you/);
 assert.match(html,/data-todo-view="action"/);
 assert.match(html,/data-cm-view="deliverable"/);
 assert.doesNotMatch(html,/Completed old task|Other project task|Canvas/);
 assert.match(html,/data-material-upload="courses\/Fall-2026\/Regression-Lab\/README.md"/);
 assert.match(html,/data-file="courses\/Fall-2026\/Regression-Lab\/README.md"/);
 assert.match(html,/Course handout/);
 assert.match(html,/data-todo-owner="courses\/Fall-2026\/Regression-Lab\/README.md"/);
 const {html:unclassified}=await fixture('#courses/course',{courseRole:'unclassified',semester:''});
 assert.match(unclassified,/Role unconfirmed/);assert.match(unclassified,/Semester<\/span><span class="workspace-detail-status">Not recorded/);
 const {html:student}=await fixture('#courses/course',{courseRole:'student'});
 assert.match(student,/My role<\/span><span class="workspace-detail-status">Student/);
});
