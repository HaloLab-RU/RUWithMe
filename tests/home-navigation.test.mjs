import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

async function fixture(hash){
 const elements=new Map(),events={},calls={today:0,track:[],calendar:0,commitments:0,replaces:[]};let daily,content;
 const element=()=>({classList:{remove(){},toggle(){}},addEventListener(){},showModal(){this.open=true;},close(){this.open=false;}});
 const document={querySelector(selector){if(!elements.has(selector))elements.set(selector,element());return elements.get(selector);},querySelectorAll:()=>[],createElement:element,body:{append(){}},addEventListener(){}};
 const window={addEventListener:(type,callback)=>{events[type]=callback;},scrollTo(){}};
 const location={hash,replace(value){calls.replaces.push(value);this.hash=value;queueMicrotask(()=>events.hashchange?.());}};
 for(const name of ['RULocalEvents','RUPDF','RUToday','RUWorkspaceMode','RUContent','RUSessions','RUTrack','RUResearch','RUCommitments','RUTodos','RUCalendar','RUDaily','RUMaterials'])window[name]={init(){},context:()=>({}),paintReview(){}};
 Object.assign(window.RUToday,{day:()=>'2026-10-22',render(){calls.today++;return '<h1>Today</h1>';}});
 Object.assign(window.RUTrack,{render(tab){calls.track.push(tab);return '<h1>Track '+tab+'</h1>';},context:()=>({trackTab:'records'})});
 Object.assign(window.RUCommitments,{dashboard(){calls.commitments++;return 'Complete manager';},context:()=>({commitmentFilter:'archived'})});
 window.RUCalendar.dashboard=()=>{calls.calendar++;return 'Schedule';};
 window.RUContent.init=api=>{content=api;};
 Object.assign(window.RUDaily,{init:api=>{daily=api;},sync(){}});
 const snapshot={revision:'navigation-fixture',records:{calendar:{timeZone:'America/New_York'}},items:{research:[]},inbox:[]};
 vm.runInNewContext(await readFile(new URL('../app/app.js',import.meta.url),'utf8'),{window,document,location,queueMicrotask,setInterval(){},setTimeout(){},clearTimeout(){},fetch:async()=>({ok:true,json:async()=>snapshot})});
 await content.refresh();
 return{elements,calls,location,daily};
}

test('Today is the only home renderer and the former Dashboard address redirects without duplicating widgets',async()=>{
 for(const hash of ['','#today','#dashboard']){
  const {elements,calls,location,daily}=await fixture(hash);
  assert.match(elements.get('#page').innerHTML,/<h1>Today<\/h1>/);
  assert.equal(elements.get('#breadcrumb').textContent,'Today');
  assert.equal(JSON.parse(daily.context()).section,'today');
  assert.equal(calls.calendar,0);
  assert.equal(calls.commitments,0);
  if(hash==='#dashboard'){assert.deepEqual(calls.replaces,['#today']);assert.equal(location.hash,'#today');}
 }
 const index=await readFile(new URL('../app/index.html',import.meta.url),'utf8');
 assert.ok(index.includes('data-nav="today"'));
 assert.ok(!index.includes('data-nav="dashboard"'));
});

test('Track Commitments routing reaches the new tab and passes its saved filter to Daily',async()=>{
 const {elements,calls,daily}=await fixture('#track/commitments');
 assert.equal(calls.track.at(-1),'commitments');
 assert.match(elements.get('#page').innerHTML,/Track commitments/);
 const context=JSON.parse(daily.context());
 assert.equal(context.section,'track');
 assert.equal(context.view.trackTab,'commitments');
 assert.equal(context.view.commitmentFilter,'archived');
});
