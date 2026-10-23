import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,symlink,rm,readdir,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildDemo} from '../scripts/seed-demo.mjs';
import {buildLayoutDemo,replaceWithLayoutDemo} from '../scripts/prepare-layout-demo.mjs';
import {indexWorkspace} from '../app/workspace.mjs';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const counts={research:3,courses:2,learn:3,career:0,admin:2,personal:2,inbox:0};
async function fixture(t){
 const base=await realpath(await mkdtemp(join(tmpdir(),'ruwithme-layout-'))),source=join(base,'workspace');
 t.after(()=>rm(base,{recursive:true,force:true}));
 await buildDemo(source,{date:'2026-10-21'});return{base,source};
}
function emptyActivity(data){
 assert.deepEqual(data.counts,counts);assert.deepEqual(data.inbox,[]);assert.deepEqual(data.ideas,[]);
 assert.deepEqual(data.records.commitments.items,[]);assert.deepEqual(data.records.sessions.items,[]);
 assert.deepEqual(data.records.calendar.sources,[]);assert.deepEqual(data.records.calendar.events,[]);assert.deepEqual(data.records.calendar.workBlocks,[]);
 assert.deepEqual(data.records.track.drafts,[]);assert.deepEqual(data.records.track.entries,[]);assert.deepEqual(data.records.days,[]);
 assert.equal(data.records.calendar.timeZone,'America/New_York');assert.equal(data.mode,null);
}

test('layout fixture preserves verified synthetic bytes, adds labelled cards and leaves all activity empty',async t=>{
 const {base,source}=await fixture(t),target=join(base,'layout');
 await writeFile(join(source,'research/Robust-Distribution-Shift/notes/private-addition.md'),'Real addition must not enter the demo.');
 const data=await buildLayoutDemo(target,{sourceRoot:source});emptyActivity(data);
 const baseline=JSON.parse(await readFile(join(repo,'app/sample-project-baseline.json'),'utf8'));
 for(const item of baseline.projects){const folder=dirname(item.path);for(const path of Object.keys(item.files))assert.deepEqual(await readFile(join(target,folder,path)),await readFile(join(source,folder,path)));}
 await assert.rejects(readFile(join(target,'research/Robust-Distribution-Shift/notes/private-addition.md')),e=>e.code==='ENOENT');
 assert.equal(data.demo.synthetic,true);assert.equal(data.demo.scenarioDate,'2026-10-22');
 assert.ok(Object.values(data.items).flat().every(item=>item.exampleWorkspace));
 assert.deepEqual(data.items.research.map(item=>[item.path,item.priority]),[['research/Robust-Distribution-Shift/README.md','p1'],['research/Sequential-Uncertainty/README.md','p2'],['research/Adaptive-Inference/README.md','p3']]);
 const reading=data.items.learn.find(item=>item.title==='Probabilistic Artificial Intelligence');
 assert.equal(reading.status,'Not started');assert.match(reading.notes,/https:\/\/arxiv.org\/abs\/2502\.05244/);assert.match(reading.notes,/Andreas Krause and Jonas Hübotter/);assert.match(reading.notes,/No reading progress has been recorded/);
 for(const item of [...data.items.admin,...data.items.personal,reading])for(const sub of ['notes','files'])assert.deepEqual(await readdir(join(target,item.folder,sub)),[]);
});

test('changed baseline content aborts the build without touching source or populating staging',async t=>{
 const {base,source}=await fixture(t),target=join(base,'layout'),path=join(source,'research/Robust-Distribution-Shift/README.md');
 await writeFile(path,'A real edited project');
 await assert.rejects(buildLayoutDemo(target,{sourceRoot:source}),/Synthetic baseline changed/);
 assert.equal(await readFile(path,'utf8'),'A real edited project');assert.deepEqual(await readdir(target),[]);
});

test('source roots, retained directories and retained files cannot be symbolic links',async t=>{
 const {base,source}=await fixture(t),link=join(base,'source-link');await symlink(source,link);
 await assert.rejects(buildLayoutDemo(join(base,'layout-root'),{sourceRoot:link}),/symbolic links/);
 const file=join(source,'research/Adaptive-Inference/README.md'),outside=join(base,'outside.md');await writeFile(outside,await readFile(file));await rm(file);await symlink(outside,file);
 await assert.rejects(buildLayoutDemo(join(base,'layout-file'),{sourceRoot:source}),/symbolic links/);
 await rm(file);await writeFile(file,await readFile(outside));
 const folder=join(source,'learn/Martingales/files'),outsideFolder=join(base,'outside-folder');await mkdir(outsideFolder);await rm(folder,{recursive:true});await symlink(outsideFolder,folder);
 await assert.rejects(buildLayoutDemo(join(base,'layout-dir'),{sourceRoot:source}),/symbolic links/);
});

test('full replacement archives real and hidden original bytes and preserves private runtime state',async t=>{
 const {base,source}=await fixture(t),maintenance=join(base,'.ruwithme');await mkdir(maintenance);
 const realFiles={
  'research/Example-Study/README.md':Buffer.from('# Real project\nSensitive research notes.\n'),
  'research/Example-Study/.edit-history/original':Buffer.from([0,1,2,255]),
  '.material-properties.json':Buffer.from('{"private":"metadata"}\n'),
  'career/private-resume.txt':Buffer.from('Real application history'),
  'admin/real-form.txt':Buffer.from('Original admin data'),
  'personal/private-note.txt':Buffer.from('Original personal data'),
  'inbox/.filings.json':Buffer.from('Original filing receipts'),
  'records/days/2026-10-21.md':Buffer.from('Original day notes')
 };
 for(const [path,bytes] of Object.entries(realFiles)){await mkdir(dirname(join(source,path)),{recursive:true});await writeFile(join(source,path),bytes);}
 await writeFile(join(maintenance,'runtime-sentinel'),'Keep runtime and chats untouched');
 const originalRecords=await readFile(join(source,'records/commitments.json'));
 const result=await replaceWithLayoutDemo({root:source,maintenanceRoot:maintenance});
 emptyActivity(await indexWorkspace(source));assert.deepEqual(result.counts,counts);
 assert.equal(result.archivedWorkspace,join(result.backup,'workspace'));
 for(const [path,bytes] of Object.entries(realFiles)){assert.deepEqual(await readFile(join(result.archivedWorkspace,path)),bytes);await assert.rejects(readFile(join(source,path)),e=>e.code==='ENOENT');}
 assert.deepEqual(await readFile(join(result.archivedWorkspace,'records/commitments.json')),originalRecords);
 assert.equal(await readFile(join(maintenance,'runtime-sentinel'),'utf8'),'Keep runtime and chats untouched');
 const restore=JSON.parse(await readFile(join(result.backup,'restore.json'),'utf8'));assert.equal(restore.workspace,source);assert.equal(restore.archivedWorkspace,result.archivedWorkspace);assert.equal(restore.filesPreserved,true);
});

test('replacement refuses changed synthetic baselines before moving the source workspace',async t=>{
 const {base,source}=await fixture(t);await writeFile(join(source,'learn/Martingales/README.md'),'Edited learning record');
 await assert.rejects(replaceWithLayoutDemo({root:source,maintenanceRoot:join(base,'.ruwithme')}),/Synthetic baseline changed/);
 assert.equal(await readFile(join(source,'learn/Martingales/README.md'),'utf8'),'Edited learning record');
 assert.deepEqual(await readdir(join(base,'.ruwithme/backups/layout-demo')),[]);
});
