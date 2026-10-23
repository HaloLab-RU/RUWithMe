import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const [sessionSource,modeSource]=await Promise.all(['sessions-ui.js','workspace-mode-ui.js'].map(name=>readFile(new URL('../app/'+name,import.meta.url),'utf8')));
const date='2026-10-23',path='courses/Fall-2026/Regression-Lab/README.md';
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const decode=value=>String(value).replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/&gt;/g,'>').replace(/&lt;/g,'<').replace(/&amp;/g,'&');
const project=extra=>({id:'regression',path,title:'Regression Lab',next:'Prepare a residual diagnostic example.',status:'Active',files:[],contextSession:null,...extra});
const session=(id,extra={})=>({id,date,createdAt:date+'T14:00:00Z',updatedAt:date+'T14:00:00Z',revision:1,ownerPath:path,workedOn:'Checked the grading rubric.',outcome:'The rubric is ready.',blockers:'',nextStep:'Prepare an absence note for the instructor.',timeZone:'America/New_York',files:[],versions:[],...extra});
function sessionFixture({item=project(),sessions=[],scenarioDate=date,now='2026-10-23T15:00:00Z'}={}){
 const snapshot={demo:scenarioDate?{scenarioDate}:null,items:{courses:[item]},records:{calendar:{timeZone:'America/New_York'},sessions:{revision:3,items:sessions}}},posts=[];
 class FixedDate extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return new Date(now).getTime();}}
 const window={},document={addEventListener(){}};
 vm.runInNewContext(sessionSource,{window,document,Date:FixedDate,Intl});
 window.RUSessions.init({snapshot:()=>snapshot,post:async(...args)=>posts.push(args)});
 return{item,snapshot,posts,render:()=>window.RUSessions.nextStep(item)};
}

test('workspace next step keeps the saved project instruction editable when no session exists',()=>{
 const f=sessionFixture(),before=JSON.stringify(f.snapshot),html=f.render();
 assert.match(html,/workspace-next-step/);
 assert.match(html,/>Next step</);
 assert.match(html,/Prepare a residual diagnostic example\./);
 assert.match(html,/data-content-edit="courses\/Fall-2026\/Regression-Lab\/README.md"/);
 assert.doesNotMatch(html,/Review next step|data-session-context=/);
 assert.equal(JSON.stringify(f.snapshot),before);
 assert.equal(f.posts.length,0);
});

test('a different latest session next step is a review suggestion rather than a silent project update',()=>{
 const f=sessionFixture({sessions:[session('latest')]}),before=JSON.stringify(f.snapshot),html=f.render();
 assert.match(html,/Prepare a residual diagnostic example\./);
 assert.match(html,/Prepare an absence note for the instructor\./);
 assert.match(html,/Review next step/);
 assert.match(html,/data-session-context="latest"/);
 assert.match(html,/data-session-context-fields="next"/);
 assert.equal(f.item.next,'Prepare a residual diagnostic example.');
 assert.equal(JSON.stringify(f.snapshot),before);
 assert.equal(f.posts.length,0);
});

test('no duplicate suggestion is shown when the latest next step is empty or matches the saved instruction',()=>{
 for(const nextStep of ['', 'Prepare a residual diagnostic example.']){
  const f=sessionFixture({sessions:[session('latest',{nextStep})]});
  assert.match(f.render(),/Prepare a residual diagnostic example\./);
  assert.doesNotMatch(f.render(),/Review next step|data-session-context=/);
 }
 const blank=sessionFixture({item:project({next:''}),sessions:[]}).render();
 assert.match(blank,/data-content-edit=/);
 assert.doesNotMatch(blank,/undefined|null/);
});

test('reviewed next-step provenance suppresses a suggestion only for the matching session revision and field',()=>{
 const row=session('latest',{revision:2,nextStep:'Original session wording'}),canonical='Reviewed wording saved in the project.';
 const applied=sessionFixture({item:project({next:canonical,contextSession:{id:row.id,revision:2,fields:['next']}}),sessions:[row]});
 assert.match(applied.render(),/Reviewed wording saved in the project\./);
 assert.doesNotMatch(applied.render(),/Review next step|Original session wording/);
 for(const contextSession of [{id:row.id,revision:1,fields:['next']},{id:row.id,revision:2,fields:['currentUnderstanding']},{id:'older',revision:2,fields:['next']}]){
  const f=sessionFixture({item:project({next:canonical,contextSession}),sessions:[row]});
  assert.match(f.render(),/Review next step/);
  assert.match(f.render(),/Original session wording/);
 }
});

test('only the latest linked nonfuture work session can suggest a next step, regardless of array order',()=>{
 const latest=session('today-late',{createdAt:date+'T16:00:00Z',nextStep:'Newest eligible instruction'});
 const rows=[session('future',{date:'2026-10-24',nextStep:'Future instruction'}),session('other-project',{ownerPath:'research/Other/README.md',nextStep:'Unrelated instruction'}),session('yesterday-edited',{date:'2026-10-22',createdAt:'2026-10-22T18:00:00Z',updatedAt:'2026-10-25T18:00:00Z',nextStep:'Historical instruction'}),latest,session('today-early',{createdAt:date+'T12:00:00Z',nextStep:'Earlier instruction'}),session('general',{ownerPath:null,nextStep:'General instruction'})];
 const f=sessionFixture({sessions:rows}),before=JSON.stringify(f.snapshot),html=f.render();
 assert.match(html,/Newest eligible instruction/);
 assert.match(html,/data-session-context="today-late"/);
 assert.doesNotMatch(html,/Future instruction|Unrelated instruction|Historical instruction|Earlier instruction|General instruction/);
 assert.equal(JSON.stringify(f.snapshot),before,'rendering must not sort the stored session array in place');
});

test('a latest session without a next step does not revive a stale older instruction or previous version',()=>{
 const old=session('old',{date:'2026-10-22',nextStep:'Stale older instruction'}),corrected=session('corrected',{revision:2,nextStep:'',versions:[session('corrected',{revision:1,nextStep:'Retracted previous wording'})]});
 const f=sessionFixture({sessions:[old,corrected]}),html=f.render();
 assert.match(html,/Prepare a residual diagnostic example\./);
 assert.doesNotMatch(html,/Review next step|Stale older instruction|Retracted previous wording/);
});

test('ordinary mode uses the workspace local day and safely escapes project text and session identifiers',()=>{
 const f=sessionFixture({scenarioDate:null,now:'2026-10-24T02:00:00Z',item:project({next:'Saved <script>bad()</script> & "quote"'}),sessions:[session('safe" onclick="bad()', {nextStep:'Session <img src=x onerror=bad()> & action'}),session('tomorrow',{date:'2026-10-24',nextStep:'Tomorrow instruction'})]}),html=f.render();
 assert.match(html,/Saved &lt;script&gt;bad\(\)&lt;\/script&gt; &amp; &quot;quote&quot;/);
 assert.match(html,/Session &lt;img src=x onerror=bad\(\)&gt; &amp; action/);
 assert.match(html,/data-session-context="safe&quot; onclick=&quot;bad\(\)"/);
 assert.doesNotMatch(html,/<script>|<img |data-session-context="safe" onclick=|Tomorrow instruction/);
 assert.equal(f.posts.length,0);
});

function reviewFixture(){
 const proposal={path,expectedRevision:'project-sha',source:{id:'latest',date,revision:4,workedOn:'Reviewed the exam batch.'},current:{currentUnderstanding:'Saved understanding',openQuestions:'Saved question',next:'Saved instruction'},suggested:{currentUnderstanding:'New understanding',openQuestions:'Two missing submissions',next:'Draft an absence note'},appliedFields:[],sampleBlocked:false};
 const listeners=new Map(),dialogs=[],posts=[],reads=[],notices=[];let form,refreshes=0;
 const dialog={open:true,close(){this.open=false;}};
 const document={addEventListener(type,callback){const callbacks=listeners.get(type)||[];callbacks.push(callback);listeners.set(type,callbacks);},getElementById(id){return id==='session-context-form'?form:id==='dialog'?dialog:null;}};
 const api={escape,dialog(title,html){dialogs.push({title,html});dialog.open=true;const controls={},error={textContent:''},reload={innerHTML:''},cancel={},submit={disabled:false};
  for(const key of Object.keys(proposal.suggested)){
   const select=html.match(new RegExp('<input[^>]*data-context-select="'+key+'"[^>]*>'))?.[0]||'';
   const value=html.match(new RegExp('<textarea[^>]*data-context-value="'+key+'"[^>]*>([\\s\\S]*?)</textarea>'))?.[1]||'';
   controls[key]={selected:{checked:/\bchecked\b/.test(select)},value:{value:decode(value).replace(/^\n/,'')}};
  }
  form={controls,addEventListener(){},querySelector(selector){const select=selector.match(/^\[data-context-select="([^"]+)"\]$/),value=selector.match(/^\[data-context-value="([^"]+)"\]$/);return select?controls[select[1]].selected:value?controls[value[1]].value:selector==='[type=submit]'?submit:selector==='[data-context-cancel]'?cancel:selector==='.error'?error:selector==='[data-context-reload]'?reload:null;}};
 },post:async(url,body)=>{posts.push({url,body});return{};},refresh:async()=>{refreshes++;},notice:value=>notices.push(value)};
 const window={},fetch=async url=>{reads.push(url);return{ok:true,json:async()=>JSON.parse(JSON.stringify(proposal))};};
 vm.runInNewContext(modeSource,{window,document,fetch});window.RUWorkspaceMode.init(api);
 const click=async fields=>{const button={disabled:false,dataset:{sessionContext:'latest',...(fields?{sessionContextFields:fields}:{})},hasAttribute:()=>false};for(const callback of listeners.get('click')||[])callback({target:{closest:()=>button}});await new Promise(resolve=>setImmediate(resolve));};
 return{proposal,dialogs,posts,reads,notices,click,get form(){return form;},get dialog(){return dialog;},get refreshes(){return refreshes;}};
}

test('Review next step opens a next-only proposal and requires explicit confirmation before writing',async()=>{
 const f=reviewFixture();await f.click('next');
 assert.equal(f.reads.length,1);
 assert.equal(f.reads[0],'/api/sessions/project-context?id=latest');
 assert.equal(f.dialogs.at(-1).title,'Update project from session');
 assert.match(f.dialogs.at(-1).html,/Confirm project update/);
 assert.equal(f.form.controls.next.selected.checked,true);
 assert.equal(f.form.controls.currentUnderstanding.selected.checked,false);
 assert.equal(f.form.controls.openQuestions.selected.checked,false);
 assert.equal(f.posts.length,0,'opening and reviewing a suggestion must be read-only');
 f.form.controls.next.value.value='Reviewed absence-note instruction';
 await f.form.onsubmit({preventDefault(){}});
 assert.equal(f.posts.length,1);
 assert.equal(f.posts[0].url,'/api/sessions/project-context/save');
 assert.deepEqual(JSON.parse(JSON.stringify(f.posts[0].body)),{id:'latest',expectedSessionRevision:4,expectedRevision:'project-sha',changes:{next:'Reviewed absence-note instruction'},confirmed:true});
 assert.equal(f.refreshes,1);
 assert.equal(f.dialog.open,false);
});

test('canceling a next-step review never writes, while ordinary Update project keeps all eligible fields selected',async()=>{
 const canceled=reviewFixture();await canceled.click('next');canceled.form.querySelector('[data-context-cancel]').onclick();
 assert.equal(canceled.posts.length,0);
 assert.equal(canceled.dialog.open,false);
 const ordinary=reviewFixture();await ordinary.click();
 for(const key of ['currentUnderstanding','openQuestions','next'])assert.equal(ordinary.form.controls[key].selected.checked,true);
 assert.equal(ordinary.posts.length,0);
});
