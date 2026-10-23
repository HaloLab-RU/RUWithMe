import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../app/today-ui.js',import.meta.url),'utf8');
const date='2026-10-22';
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function project(id,space='research',extra={}){return{id,path:`${space}/${id}/README.md`,title:id,summary:`${id} summary`,next:`${id} next step`,files:[],...extra};}
function todo(id,ownerPath,extra={}){return{id,kind:'todo',title:id,status:'open',todayDates:[date],ownerPath,estimateMinutes:30,...extra};}
function fixture({projects=[],todos=[],commitments=[],sessions=[]}={}){
 const snapshot={demo:{scenarioDate:date},items:Object.fromEntries(['research','courses','learn','career','admin','personal'].map(space=>[space,projects.filter(item=>item.path.startsWith(space+'/'))])),records:{calendar:{timeZone:'America/New_York'},commitments:{items:[...todos,...commitments]},sessions:{items:sessions},track:{entries:[],drafts:[]}}};
 const window={RUSessions:{list:()=>'<section id="today-sessions">Logged work sessions</section>'},RUTodos:{todayCard:()=>'<section id="today-todos">Chosen Todos</section>'},RUCalendar:{dashboard:()=>'<section id="today-calendar">Calendar</section>'}};
 vm.runInNewContext(source,{window,Intl,Date});
 window.RUToday.init({escape,snapshot:()=>snapshot});
 return{render:()=>window.RUToday.render(),snapshot};
}
const cards=html=>[...html.matchAll(/<article class="resume-card">[\s\S]*?<\/article>/g)].map(match=>match[0]);

test('Continue from here follows a chosen P2 Todo and excludes unrelated P1 research',()=>{
 const primary=project('Unchosen P1','research',{priority:'p1'}),chosen=project('Chosen P2','research',{priority:'p2'});
 const {render}=fixture({projects:[primary,chosen],todos:[todo('chosen-action',chosen.path)]});
 const selected=cards(render());
 assert.equal(selected.length,1);
 assert.match(selected[0],/>Chosen P2<\/a>/);
 assert.doesNotMatch(selected[0],/Unchosen P1/);
 assert.match(selected[0],/Chosen P2 next step/);
});

test('chosen Todo order determines the distinct project cards across all six content spaces',()=>{
 const spaces=['research','courses','learn','career','admin','personal'];
 const projects=spaces.map(space=>project(`${space}-workspace`,space));
 const chosen=[projects[5],projects[2],projects[0],projects[4],projects[1],projects[3]];
 const todos=chosen.flatMap((item,index)=>index===0?[todo('first',item.path),todo('duplicate',item.path)]:[todo(`todo-${index}`,item.path)]);
 const {render}=fixture({projects,todos});
 const selected=cards(render());
 assert.equal(selected.length,6);
 assert.deepEqual(selected.map(html=>html.match(/<h3><a[^>]+>([^<]+)<\/a>/)[1]),chosen.map(item=>item.title));
 for(const [index,item] of chosen.entries())assert.ok(selected[index].includes(`href="#${item.path.split('/')[0]}/${item.id}"`));
});

test('closed, unchosen and previous-day Todos do not produce continuation cards',()=>{
 const projects=['done','cancelled','yesterday','unchosen'].map(id=>project(id,'research',{priority:'p1'}));
 const {render}=fixture({projects,todos:[todo('done',projects[0].path,{status:'done'}),todo('cancelled',projects[1].path,{status:'cancelled'}),todo('yesterday',projects[2].path,{todayDates:['2026-10-21']}),todo('unchosen',projects[3].path,{todayDates:[]})]});
 const html=render();
 assert.equal(cards(html).length,0);
 assert.match(html,/Choose a Todo for Today and link it to a workspace/);
 assert.match(html,/0 chosen actions/);
});

test('standalone Todos and unavailable owner paths keep actions without inventing a workspace',()=>{
 const {render}=fixture({projects:[project('unrelated','research',{priority:'p1'})],todos:[todo('general',null),todo('unavailable','research/missing/README.md')]});
 const html=render();
 assert.equal(cards(html).length,0);
 assert.match(html,/2 chosen actions/);
 assert.match(html,/id="today-todos"/);
 assert.match(html,/href="#track\/todos">Choose actions/);
});

test('selected projects retain the latest session resume context without mutating workspace records',()=>{
 const item=project('Example-Research','research',{files:[{path:'research/Example-Research/notes/check.md'}]});
 const sessions=[{id:'old',revision:1,ownerPath:item.path,date:'2026-10-20',createdAt:'2026-10-20T14:00:00Z',outcome:'Old outcome',nextStep:'Old next step',files:[]},{id:'latest',revision:2,ownerPath:item.path,date,createdAt:'2026-10-22T14:00:00Z',outcome:'Checked main text',blockers:'Appendix remains',nextStep:'Check Appendix A',files:['research/Example-Research/notes/check.md','research/Other/notes/private.md']},{id:'future',revision:1,ownerPath:item.path,date:'2026-10-23',createdAt:'2026-10-23T14:00:00Z',outcome:'Future outcome',nextStep:'Future next step',files:[]}];
 const {render,snapshot}=fixture({projects:[item],todos:[todo('check-appendix',item.path)],sessions});
 const before=JSON.stringify(snapshot),selected=cards(render())[0];
 assert.match(selected,/Checked main text/);
 assert.match(selected,/Appendix remains/);
 assert.match(selected,/Check Appendix A/);
 assert.match(selected,/Project next step: Example-Research next step/);
 assert.match(selected,/data-file="research\/Example-Research\/notes\/check.md"/);
 assert.match(selected,/data-session-new="research\/Example-Research\/README.md"/);
 assert.doesNotMatch(selected,/Old outcome|Old next step|Future outcome|Future next step|private.md/);
 assert.equal(JSON.stringify(snapshot),before);
});

test('Today keeps short deliverable and waiting summaries and links full management to Track',()=>{
 const commitments=Array.from({length:7},(_,i)=>({id:`commitment-${i}`,kind:'commitment',title:`Deliverable ${i}`,status:'open',dueDate:date,category:'research'}));
 commitments.push(...Array.from({length:6},(_,i)=>({id:`waiting-${i}`,kind:'commitment',title:`Review ${i}`,status:'waiting',waitingOn:'Collaborator',category:'research'})));
 const html=fixture({commitments}).render();
 assert.match(html,/href="#track\/commitments">All →/);
 assert.doesNotMatch(html,/href="#dashboard"/);
 assert.equal((html.match(/class="delivery-row"/g)||[]).length,5);
 const waiting=html.match(/<section class="waiting-panel">([\s\S]*?)<\/section>/)[1];
 assert.equal((waiting.match(/data-cm-view=/g)||[]).length,4);
});
