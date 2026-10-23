import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';

const [sessionsSource,todaySource]=await Promise.all(['sessions-ui.js','today-ui.js'].map(name=>readFile(new URL('../app/'+name,import.meta.url),'utf8')));
const spaces=['research','courses','learn','career','admin','personal'],date='2026-10-22';
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const project=(space,index=0)=>({id:`${space}-${index}`,path:`${space}/Project-${index}/README.md`,title:`${space} project ${index}`,priority:'p1',files:[]});
const session=(id,extra={})=>({id,date,createdAt:date+'T15:00:00Z',updatedAt:date+'T15:00:00Z',revision:1,timeZone:'America/New_York',ownerPath:null,workedOn:`Work ${id}`,outcome:'An observation',blockers:'An open question',nextStep:'The next step',files:[],versions:[],...extra});
function fixture({projects=[],sessions=[],scenarioDate=date,timeZone='America/New_York',now='2026-10-22T16:00:00Z'}={}){
 const snapshot={demo:scenarioDate?{scenarioDate}:null,inbox:[],items:Object.fromEntries(spaces.map(space=>[space,projects.filter(item=>item.path.startsWith(space+'/'))])),records:{calendar:{timeZone},commitments:{items:[]},sessions:{revision:7,items:sessions},track:{entries:[],drafts:[]}}};
 const listeners=new Map(),dialogs=[],posts=[],notices=[];let form,refreshes=0;
 const dialog={open:true,close(){this.open=false;}};
 const document={addEventListener(type,callback){const rows=listeners.get(type)||[];rows.push(callback);listeners.set(type,rows);},querySelector(selector){return selector==='#session-form'?form:selector==='#dialog'?dialog:null;},getElementById(id){return id==='dialog'?dialog:null;}};
 const api={escape,snapshot:()=>snapshot,dialog(title,html){dialogs.push({title,html});dialog.open=true;if(html.includes('id="session-form"')){const submit={disabled:false},error={textContent:''};form={values:{},querySelector:selector=>selector==='[type="submit"]'?submit:selector==='[data-session-error]'?error:null};}},post:async(path,body)=>{posts.push({path,body});return {...body,revision:(body.expectedItemRevision||0)+1};},refresh:async()=>{refreshes++;},notice:text=>notices.push(text)};
 class FixedDate extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return new Date(now).getTime();}}
 class FormData{constructor(el){this.values=el.values;}get(name){return this.values[name]??'';}getAll(name){return this.values[name]||[];}}
 const window={RUTodos:{todayCard:()=>'<section id="today-focus">Chosen Todos</section>'},RUCalendar:{dashboard:()=>'<section id="today-calendar">Calendar</section>'}};
 const context={window,document,Intl,Date:FixedDate,crypto:{randomUUID},FormData};
 vm.runInNewContext(sessionsSource,context);window.RUSessions.init(api);
 vm.runInNewContext(todaySource,context);window.RUToday.init(api);
 const click=attributes=>{const dataset=Object.fromEntries(Object.entries(attributes).filter(([key])=>key.startsWith('data-')).map(([key,value])=>[key.slice(5).replace(/-([a-z])/g,(_,char)=>char.toUpperCase()),value]));const button={dataset,hasAttribute:key=>Object.hasOwn(attributes,key)};for(const callback of listeners.get('click')||[])callback({target:{closest:()=>button}});};
 return {snapshot,window,dialogs,posts,notices,click,render:()=>window.RUToday.render(),list:options=>window.RUSessions.list(options),get form(){return form;},get refreshes(){return refreshes;}};
}
const entries=html=>[...html.matchAll(/<article class="session-entry">/g)].length;
const todayPanel=html=>html.match(/<section class="session-panel session-date-panel">[\s\S]*?<\/section>/)?.[0]||'';

test('Today shows reported work from general work and every workspace without requiring chosen Todos',()=>{
 const projects=spaces.map(space=>project(space)),sessions=[session('general'),...projects.map((item,index)=>session(`workspace-${index}`,{ownerPath:item.path}))];
 const f=fixture({projects,sessions}),before=JSON.stringify(f.snapshot),html=f.render(),panel=todayPanel(html);
 assert.match(panel,/Today&#39;s work sessions/);
 assert.equal(entries(panel),7);
 assert.match(panel,/General work/);
 for(const item of projects)assert.ok(panel.includes(`href="#${item.path.split('/')[0]}/${item.id}"`));
 assert.match(html,/0 chosen actions/);
 assert.match(html,/Choose a Todo for Today/);
 assert.match(panel,/data-session-edit="workspace-0"/);
 assert.match(panel,/data-session-context="workspace-0"/);
 assert.equal(JSON.stringify(f.snapshot),before);
 assert.equal(f.posts.length,0);
});

test('Today uses the workspace local work date across UTC midnight rather than session creation dates',()=>{
 const day='2026-10-21',f=fixture({scenarioDate:null,now:'2026-10-22T02:30:00Z',sessions:[session('local-day',{date:day,createdAt:'2026-10-22T02:00:00Z',timeZone:'Asia/Tokyo'}),session('backfilled-yesterday',{date:'2026-10-20',createdAt:'2026-10-22T02:00:00Z'}),session('utc-day',{date:'2026-10-22',createdAt:'2026-10-22T02:00:00Z'})]});
 assert.equal(f.window.RUToday.day(),day);
 const panel=todayPanel(f.render());
 assert.match(panel,/Work local-day/);
 assert.doesNotMatch(panel,/Work backfilled-yesterday|Work utc-day/);
 assert.match(panel,/data-session-date="2026-10-21"/);
 assert.match(panel,/data-collection-scroll="sessions:date:2026-10-21"/);
 const tokyo=fixture({scenarioDate:null,timeZone:'Asia/Tokyo',now:'2026-10-21T22:00:00Z',sessions:[session('tokyo-day')]});
 assert.equal(tokyo.window.RUToday.day(),date);
 assert.match(todayPanel(tokyo.render()),/Work tokyo-day/);
});

test('bounded day lists keep every session and expose a stable keyboard-accessible scrolling region',()=>{
 const f=fixture({sessions:Array.from({length:35},(_,index)=>session(`row-${index}`))});
 const panel=todayPanel(f.render());
 assert.equal(entries(panel),35);
 assert.match(panel,/class="session-date-list" role="region" aria-label="Today&#39;s work sessions" tabindex="0" data-collection-scroll="sessions:date:2026-10-22"/);
 assert.doesNotMatch(panel,/View all work sessions|data-session-load-more/);
 assert.equal(entries(f.list({date,bounded:true,limit:2})),35);
 assert.equal(entries(f.list({date,limit:2})),2);
 assert.match(f.list({date,limit:2}),/View all work sessions/);
 assert.match(f.list({date}),/<h2>Work sessions/);
 assert.match(f.list({date,title:'<Unsafe title>',bounded:true}),/&lt;Unsafe title&gt;/);
});

test('today keeps the current correction once while preserving previous versions and existing project/file actions',()=>{
 const item=project('research'),old=session('corrected',{revision:1,date:'2026-10-21',workedOn:'Original report',outcome:'Original observation'}),row=session('corrected',{revision:2,ownerPath:item.path,workedOn:'Corrected report',outcome:'Corrected observation',files:[`${item.path.split('/README.md')[0]}/notes/check.md`],versions:[old]});
 const f=fixture({projects:[item],sessions:[row]}),panel=todayPanel(f.render());
 assert.equal(entries(panel),1);
 assert.equal((panel.match(/data-session-edit="corrected"/g)||[]).length,1);
 assert.match(panel,/Corrected report/);
 assert.match(panel,/<details class="session-versions"><summary>Previous versions \(1\)<\/summary>/);
 assert.match(panel,/Original report/);
 assert.match(panel,/Version 1/);
 assert.match(panel,/data-session-context="corrected"/);
 assert.match(panel,/data-file="research\/Project-0\/notes\/check.md"/);
 assert.match(f.list({ownerPath:item.path}),/class="session-panel session-project-panel"/);
 assert.doesNotMatch(f.list({ownerPath:item.path}),/session-date-list/);
 assert.equal(f.posts.length,0);
});

test('empty Today keeps a compact dated Log a session action using the existing form',()=>{
 const f=fixture(),panel=todayPanel(f.render());
 assert.match(panel,/<h2>Today&#39;s work sessions <span class="small">0<\/span>/);
 assert.match(panel,/No work sessions recorded here yet/);
 assert.doesNotMatch(panel,/session-date-list|data-session-edit/);
 assert.match(panel,/data-session-new="" data-session-date="2026-10-22"/);
 f.click({'data-session-new':'','data-session-date':date});
 assert.equal(f.dialogs.at(-1).title,'Log a session');
 assert.match(f.dialogs.at(-1).html,/type="date" name="date" value="2026-10-22"/);
 assert.match(f.dialogs.at(-1).html,/<option value="">General work<\/option>/);
 assert.equal(f.posts.length,0);
});

test('Today Edit delegates to the canonical session form and saves with the existing revisions',async()=>{
 const item=project('research'),row=session('editable',{ownerPath:item.path,revision:3,workedOn:'Saved report',versions:[session('editable',{revision:2,workedOn:'Previous report'})]}),f=fixture({projects:[item],sessions:[row]});
 assert.match(todayPanel(f.render()),/data-session-edit="editable"/);
 f.click({'data-session-edit':'editable'});
 assert.equal(f.dialogs.at(-1).title,'Edit work session');
 assert.match(f.dialogs.at(-1).html,/>Saved report<\/textarea>/);
 assert.match(f.dialogs.at(-1).html,/value="research\/Project-0\/README.md" selected/);
 assert.equal(f.posts.length,0);
 f.form.values={date,ownerPath:item.path,workedOn:'Reviewed report',outcome:'Checked',blockers:'',nextStep:'Continue',files:[]};
 await f.form.onsubmit({preventDefault(){}});
 assert.equal(f.posts.length,1);
 assert.equal(f.posts[0].path,'/api/sessions/save');
 assert.equal(f.posts[0].body.id,'editable');
 assert.equal(f.posts[0].body.expectedRevision,7);
 assert.equal(f.posts[0].body.expectedItemRevision,3);
 assert.equal(f.posts[0].body.ownerPath,item.path);
 assert.equal(f.posts[0].body.workedOn,'Reviewed report');
 assert.equal(f.refreshes,1);
 assert.equal(f.dialogs.at(-1).title,'Session saved');
});
