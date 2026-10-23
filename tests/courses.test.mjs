import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,writeFile,symlink,rm,rename,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createItem,indexWorkspace,safeFile} from '../app/workspace.mjs';
import {importCanvasCourses,readCanvasCourseSnapshot} from '../app/courses.mjs';
const executeFile=promisify(execFile),observedAt='2026-10-21T14:00:00.000Z';
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'ruwithme-courses-'));
 for(const category of ['research','courses','learn','inbox'])await mkdir(join(root,category));
 t.after(()=>rm(root,{recursive:true,force:true}));return root;
}
function course(overrides={}){
 return{courseId:'12345',title:'Probability',code:'STAT 500',term:'Fall 2026',role:'ta',url:'https://rutgers.instructure.com/courses/12345',sourceScope:'Manual browser observation of the visible assignments page; other assignments and syllabus were not inspected.',assignments:[{id:'99',title:'Homework 1',url:'https://rutgers.instructure.com/courses/12345/assignments/99',dueDate:'2026-10-28',displayDue:'Oct 28 at 11:59 pm'}],...overrides};
}

test('manual course roles are explicit while legacy courses stay unclassified',async t=>{
 const root=await fixture(t);
 await createItem(root,{category:'courses',title:'My class',semester:'Fall 2026',courseRole:'student'});
 await createItem(root,{category:'courses',title:'My teaching',semester:'Fall 2026',courseRole:'ta'});
 await mkdir(join(root,'courses/Old/Legacy'),{recursive:true});await writeFile(join(root,'courses/Old/Legacy/README.md'),'# Legacy\n');
 const indexed=await indexWorkspace(root),byTitle=new Map(indexed.items.courses.map(row=>[row.title,row]));
 assert.equal(byTitle.get('My class').courseRole,'student');assert.equal(byTitle.get('My teaching').courseRole,'ta');assert.equal(byTitle.get('Legacy').courseRole,'unclassified');
 for(const row of indexed.items.courses){assert.equal(row.canvas,null);assert.equal(row.historicalExample,false);}
 await assert.rejects(createItem(root,{category:'courses',title:'Bad role',semester:'Fall 2026',courseRole:'teacher'}),e=>e.status===400);
});

test('explicit browser projection imports TA and historical student courses with only observed facts',async t=>{
 const root=await fixture(t),sources=[
  course({accessToken:'must-not-be-saved',enrollment:{privateEmail:'private@example.com'}}),
  course({courseId:'23456',title:'Statistical Inference',code:'STAT 501',url:'https://rutgers.instructure.com/courses/23456?access_token=never-store#section',assignments:[]}),
  course({courseId:'34567',title:'Past Learning',code:'STAT 610',term:'Spring 2026',role:'student',historicalExample:true,url:'https://rutgers.instructure.com/courses/34567',assignments:[{id:'11',title:'Observed old assignment',dueAt:'2026-04-01T23:59:00-04:00'}],syllabus:{url:'https://rutgers.instructure.com/courses/34567/assignments/syllabus',text:'Observed syllabus\n\n<literal text> & "notes"'}})
 ];
 const result=await importCanvasCourses(root,{courses:sources,observedAt});assert.equal(result.created,3);assert.equal(result.updated,0);
 const indexed=await indexWorkspace(root);assert.equal(indexed.items.courses.length,3);assert.equal(indexed.items.courses.filter(row=>row.courseRole==='ta').length,2);
 const historical=indexed.items.courses.find(row=>row.courseRole==='student');assert.equal(historical.historicalExample,true);assert.equal(historical.semester,'Spring 2026');
 assert.equal(historical.canvas.syncedAt,observedAt);assert.equal(historical.canvas.syncMethod,'manual-browser');assert.equal(historical.canvas.assignments[0].dueAt,'2026-04-02T03:59:00.000Z');assert.equal(historical.canvas.assignments[0].dueDate,undefined);
 assert.equal(historical.canvas.syllabus.text,sources[2].syllabus.text);
 const first=indexed.items.courses.find(row=>row.canvas.courseId==='12345');assert.equal(first.canvas.assignments[0].dueAt,undefined);assert.equal(first.canvas.assignments[0].completed,undefined);assert.match(first.canvas.sourceScope,/other assignments/);
 for(const row of indexed.items.courses){
  assert.deepEqual(row.files,[]);assert.deepEqual((await readdir(join(root,row.folder))).sort(),['.canvas.json','README.md','files','notes']);
  await assert.rejects(safeFile(root,row.folder+'/.canvas.json'),e=>e.status===403);
  const body=await readFile(join(root,row.folder,'.canvas.json'),'utf8');assert.ok(!body.includes('must-not-be-saved'));assert.ok(!body.includes('private@example.com'));assert.ok(!body.includes('never-store'));
 }
});

test('resync is idempotent and preserves local README, original files and stable Canvas identity',async t=>{
 const root=await fixture(t),source=course({historicalExample:true}),first=await importCanvasCourses(root,{courses:[source],observedAt}),folder=first.courses[0].path.slice(0,-10);
 const snapshotFile=join(root,folder,'.canvas.json'),inode=(await stat(snapshotFile)).ino,initial=(await indexWorkspace(root)).items.courses[0];
 const again=await importCanvasCourses(root,{courses:[source],observedAt});assert.equal(again.unchanged,1);assert.equal((await stat(snapshotFile)).ino,inode);
 const note='---\ntitle: "My own course title"\nsummary: "Personal summary"\nnext: "Ask a question"\ncourse_role: "ta"\nhistorical_example: true\n---\n\n# My notes\n\nDo not replace this text.\n';
 await writeFile(join(root,folder,'README.md'),note);await writeFile(join(root,folder,'notes/personal.md'),'Original note');const binary=Buffer.from([0,128,255]);await writeFile(join(root,folder,'files/original.pdf'),binary);
 const moved=folder.replace(/\/Probability$/,'/My-local-name');await rename(join(root,folder),join(root,moved));
 const newer=course({title:'Updated Canvas title',assignments:[{id:'99',title:'Homework 1 revised',dueDate:'2026-10-29'}]});
 const sync=await importCanvasCourses(root,{courses:[newer],observedAt:'2026-10-21T15:00:00.000Z'});assert.equal(sync.updated,1);assert.equal(sync.courses[0].path,moved+'/README.md');
 assert.equal(await readFile(join(root,moved,'README.md'),'utf8'),note);assert.equal(await readFile(join(root,moved,'notes/personal.md'),'utf8'),'Original note');assert.deepEqual(await readFile(join(root,moved,'files/original.pdf')),binary);
 const updated=(await indexWorkspace(root)).items.courses[0];assert.equal(updated.id,initial.id);assert.equal(updated.title,'My own course title');assert.equal(updated.summary,'Personal summary');assert.equal(updated.next,'Ask a question');assert.equal(updated.canvas.title,'Updated Canvas title');assert.equal(updated.canvas.historicalExample,true);assert.equal(updated.historicalExample,true);
 assert.equal(updated.canvas.assignments[0].dueDate,'2026-10-29');
 const code='const {indexWorkspace}=await import(process.argv[1]);process.stdout.write(JSON.stringify(await indexWorkspace(process.argv[2])));';
 const {stdout}=await executeFile(process.execPath,['--input-type=module','-e',code,new URL('../app/workspace.mjs',import.meta.url).href,root]);assert.equal(JSON.parse(stdout).items.courses[0].id,initial.id);
});

test('collision and invalid batch preflight keep unrelated courses intact without partial imports',async t=>{
 const root=await fixture(t),manual=await createItem(root,{category:'courses',title:'Occupied',semester:'Fall 2026',courseRole:'student'}),body=await readFile(join(root,manual.path),'utf8');
 const free=course(),collision=course({courseId:'999',title:'Occupied',url:'https://rutgers.instructure.com/courses/999',assignments:[]});
 await assert.rejects(importCanvasCourses(root,{courses:[free,collision],observedAt}),e=>e.status===409);
 assert.equal(await readFile(join(root,manual.path),'utf8'),body);assert.deepEqual(await readdir(join(root,'courses/Fall-2026')),['Occupied']);
 await assert.rejects(importCanvasCourses(root,{courses:[free,{...free,courseId:'6789',url:'https://rutgers.instructure.com/courses/6789',assignments:[]}],observedAt}),e=>e.status===409);
 await assert.rejects(importCanvasCourses(root,{courses:[free,{...collision,sourceScope:undefined}],observedAt}),e=>e.status===400);
 assert.deepEqual(await readdir(join(root,'courses/Fall-2026')),['Occupied']);
 await assert.rejects(importCanvasCourses(root,{courses:[free],observedAt:undefined}),e=>e.status===400);
});

test('Canvas URL, identity, date and assignment validation precede any content writes',async t=>{
 const root=await fixture(t);
 const invalid=[
  {role:'teacher'},{courseId:'../bad'},{url:'http://rutgers.instructure.com/courses/12345'},{url:'https://user:secret@rutgers.instructure.com/courses/12345'},{url:'https://example.com/courses/12345'},{url:'https://rutgers.instructure.com/courses/999'},
  {sourceScope:''},{assignments:[{id:'x',title:'A',dueDate:'2026-02-30'}]},{assignments:[{id:'x',title:'A',dueAt:'2026-02-30T10:00:00Z'}]},{assignments:[{id:'x',title:'A',dueAt:'2026-10-28T23:59:00'}]},{assignments:[{id:'x',title:'A'},{id:'x',title:'B'}]},{assignments:[{id:'x',title:'A',url:'https://rutgers.instructure.com/courses/999/assignments/x'}]},{historicalExample:'yes'}
 ];
 for(const change of invalid)await assert.rejects(importCanvasCourses(root,{courses:[course(change)],observedAt}),e=>e.status===400);
 await assert.rejects(importCanvasCourses(root,{courses:[course()],observedAt:'2026-10-21T14:00:00'}),e=>e.status===400);
 assert.deepEqual(await readdir(join(root,'courses')),[]);
});

test('symlinked course paths or snapshots cannot redirect an import or leak source data',async t=>{
 const root=await fixture(t),outside=await mkdtemp(join(tmpdir(),'ruwithme-courses-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));
 await symlink(outside,join(root,'courses/Fall-2026'));
 await assert.rejects(importCanvasCourses(root,{courses:[course()],observedAt}),e=>e.status===403);assert.deepEqual(await readdir(outside),[]);await rm(join(root,'courses/Fall-2026'));
 const first=await importCanvasCourses(root,{courses:[course()],observedAt}),folder=first.courses[0].path.slice(0,-10),snapshot=join(root,folder,'.canvas.json'),original=await readFile(snapshot);
 await writeFile(join(outside,'private.json'),'sensitive original');await rm(snapshot);await symlink(join(outside,'private.json'),snapshot);
 await assert.rejects(readCanvasCourseSnapshot(root,folder),e=>e.status===403);
 await assert.rejects(importCanvasCourses(root,{courses:[course()],observedAt}),e=>e.status===403);
 assert.equal(await readFile(join(outside,'private.json'),'utf8'),'sensitive original');
 await rm(snapshot);await writeFile(snapshot,'{broken');await assert.rejects(importCanvasCourses(root,{courses:[course()],observedAt}),e=>e.status===422);assert.equal(await readFile(snapshot,'utf8'),'{broken');
 await writeFile(snapshot,JSON.stringify({...JSON.parse(original.toString('utf8')),syncedAt:'2026-10-21T14:00:00'}));await assert.rejects(readCanvasCourseSnapshot(root,folder),e=>e.status===422);
 await writeFile(snapshot,original);assert.equal((await indexWorkspace(root)).items.courses.length,1);
});

test('concurrent imports are idempotent and older observations cannot replace a newer snapshot',async t=>{
 const root=await fixture(t),input={courses:[course()],observedAt};
 const imports=await Promise.all([importCanvasCourses(root,input),importCanvasCourses(root,input)]);assert.deepEqual(imports.map(result=>result.created).sort(),[0,1]);assert.equal((await indexWorkspace(root)).items.courses.length,1);
 const newer='2026-10-22T10:00:00.000Z';await importCanvasCourses(root,{courses:[course({assignments:[]})],observedAt:newer});
 await assert.rejects(importCanvasCourses(root,input),e=>e.status===409);assert.equal((await indexWorkspace(root)).items.courses[0].canvas.syncedAt,newer);
});
