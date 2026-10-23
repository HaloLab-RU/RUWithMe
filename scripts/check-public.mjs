import {readdir,readFile,lstat,realpath} from 'node:fs/promises';
import {dirname,resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {indexWorkspace} from '../app/workspace.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const skipped=new Set(['.git','.ruwithme','.codex','.edit-history','node_modules','qa']);
const forbidden=path=>path.startsWith('workspace/')||path.split('/').some(p=>skipped.has(p)&&p!=='.git'||['auth.json','credentials.json','session.json','.DS_Store','Thumbs.db'].includes(p)||/^\.env(?:\.|$)/.test(p)&&p!=='.env.example'||/\.(?:pem|key|log)$/.test(p));
const findings=[];
async function walk(folder){
 const files=[];
 for(const entry of await readdir(folder,{withFileTypes:true})){
  const path=resolve(folder,entry.name),name=relative(root,path).split('\\').join('/');
  if(skipped.has(entry.name)||name==='workspace'||forbidden(name))continue;
  if(entry.isSymbolicLink()){findings.push(name+': symbolic links are not public source files');continue;}
  if(entry.isDirectory())files.push(...await walk(path));else if(entry.isFile())files.push(name);
 }
 return files;
}
let paths;
try{
 const top=execFileSync('git',['rev-parse','--show-toplevel'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
 if(await realpath(top)===await realpath(root))paths=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
}catch{}
paths??=await walk(root);
const patterns=[
 ['personal absolute home path',/\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/|\b)/],
 ['private key',/-----BEGIN [A-Z ]*PRIVATE KEY-----/],
 ['possible live access token',/\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{30,})\b/]
];
for(const path of [...new Set(paths)]){
 if(forbidden(path)){findings.push(path+': private/runtime path is included in Git');continue;}
 const file=resolve(root,path),info=await lstat(file);
 if(info.isSymbolicLink()||!info.isFile()||await realpath(file)!==file){findings.push(path+': expected a regular file inside the checkout');continue;}
 if(/\.(?:mp4|png|jpe?g|pdf)$/i.test(path))continue;
 let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(await readFile(file));}catch{findings.push(path+': unreviewed binary format');continue;}
 for(const [label,pattern] of patterns)if(pattern.test(text))findings.push(path+': '+label);
}
const examples=await indexWorkspace(resolve(root,'examples/workspace'));
if(Object.values(examples.items).flat().some(item=>!item.exampleWorkspace))findings.push('examples/workspace: every project must be labelled synthetic');
if(examples.records.commitments.items.some(row=>row.synthetic!==true)||examples.records.calendar.events.some(row=>row.synthetic!==true)||examples.records.calendar.sources.length)findings.push('examples/workspace: only explicit synthetic local appointments and responsibilities may be shipped');
if(examples.records.sessions.items.length||examples.records.track.entries.length||examples.records.track.drafts.length||examples.records.days.length||examples.inbox.length||examples.ideas.length)findings.push('examples/workspace: rehearsal activity and Inbox content must be empty');
if(findings.length){console.error(findings.join('\n'));process.exitCode=1;}else console.log(`Public-source check passed: ${paths.length} candidate files, labelled synthetic examples, no common private-path or token patterns. Media also needs visual review before publication.`);
