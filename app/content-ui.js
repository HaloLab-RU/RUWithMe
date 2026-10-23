(()=>{
 'use strict';
 let api,request=0;const drafts=new Map();
 const esc=value=>api.escape(value),labels={research:'Research question',courses:'Course overview',learn:'Learning goal'};
 async function read(path){const response=await fetch('/api/content?path='+encodeURIComponent(path));const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error),{status:response.status});return data;}
 function draw(draft){
  const fields=draft.fields,area=draft.path.split('/')[0];
  api.dialog(fields?'Edit workspace':'Edit note',`<form id="content-edit-form" class="content-editor"><p class="content-editor-path">${esc(draft.path)}</p>${fields?`<label>Name<input name="title" required maxlength="200" value="${esc(fields.title)}"></label><label>${esc(labels[area]||'Description')}<textarea name="summary" rows="3" maxlength="10000">
${esc(fields.summary)}</textarea></label>${area==='courses'?`<label>Semester<input name="semester" maxlength="80" required value="${esc(fields.semester)}"></label>`:''}<div class="content-field-row"><label>Status<input name="status" maxlength="120" placeholder="For example: Active, Paused, Completed" value="${esc(fields.status)}"></label>${area==='courses'?`<label>My role<select name="courseRole"><option value="student" ${fields.courseRole==='student'?'selected':''}>Student</option><option value="ta" ${fields.courseRole==='ta'?'selected':''}>Teaching assistant</option><option value="unclassified" ${fields.courseRole==='unclassified'?'selected':''}>Unconfirmed</option></select></label>`:''}</div><label>Current understanding<textarea name="currentUnderstanding" rows="3" maxlength="10000">
${esc(fields.currentUnderstanding)}</textarea></label><label>Open questions / Blockers<textarea name="openQuestions" rows="3" maxlength="10000">
${esc(fields.openQuestions)}</textarea></label><label>Next step<textarea name="next" rows="2" maxlength="10000">
${esc(fields.next)}</textarea></label><label>Workspace notes <span class="small">· Markdown</span><textarea class="content-note-source" name="notes" rows="8">
${esc(fields.notes)}</textarea></label>`:`<label>Note text<textarea class="content-note-source" name="content" rows="18">
${esc(draft.content)}</textarea></label>`}<p class="small">Saved to your workspace file, with the previous version kept locally.${area==='courses'?' Linked actions keep their own deadlines; course notes are maintained locally.':''}</p><p class="error" data-content-error role="alert">${esc(draft.error||'')}</p><div data-content-conflict></div><div class="form-actions"><button type="button" class="button" data-content-cancel>Cancel</button><button type="submit" class="button primary">Save changes</button></div></form>`);
  const form=document.getElementById('content-edit-form');
  const capture=()=>{if(fields){for(const key of Object.keys(fields))fields[key]=form.elements.namedItem(key).value;}else draft.content=form.elements.content.value;};
  form.addEventListener('input',capture);form.addEventListener('change',capture);
  function conflict(latest){
   const box=form.querySelector('[data-content-conflict]');
   box.innerHTML=`<div class="content-conflict"><details><summary>Review latest saved version</summary><pre>${esc(latest.content)}</pre></details><p>Your draft is still in the form above. Review and merge any changes before saving.</p><button type="button" class="button" data-content-latest>Load latest version</button><button type="button" class="button" data-content-rebase>I reviewed it; keep my draft</button></div>`;
   box.querySelector('[data-content-latest]').onclick=()=>{Object.assign(draft,latest,{error:''});delete draft.latest;draw(draft);};
   box.querySelector('[data-content-rebase]').onclick=()=>{draft.revision=latest.revision;draft.error='';delete draft.latest;form.querySelector('[data-content-error]').textContent='Latest version reviewed. Save changes when your draft is ready.';box.innerHTML='';};
  }
  if(draft.latest)conflict(draft.latest);
  form.querySelector('[data-content-cancel]').onclick=()=>{drafts.delete(draft.path);document.getElementById('dialog').close();};
  form.addEventListener('submit',async event=>{
   event.preventDefault();capture();if(draft.saving)return;draft.saving=true;
   const error=form.querySelector('[data-content-error]');error.textContent='';for(const field of form.elements)field.disabled=true;
   try{
    await api.post('/api/content/save',{path:draft.path,expectedRevision:draft.revision,...(fields?{fields}:{content:draft.content})});
    drafts.delete(draft.path);if(document.getElementById('content-edit-form')===form)document.getElementById('dialog').close();await api.refresh(true);api.notice('Workspace changes saved.');
   }catch(failure){
    draft.error=failure.message;if(document.getElementById('content-edit-form')===form)error.textContent=draft.error;
    if(failure.status===409)try{draft.latest=await read(draft.path);if(document.getElementById('content-edit-form')===form)conflict(draft.latest);}catch{api.notice('Your draft is preserved. Reopen the editor when the connection returns.');}
   }finally{draft.saving=false;for(const field of form.elements)field.disabled=false;}
  });
 }
 async function edit(path){
  const token=++request;
  try{const saved=await read(path);if(token!==request)return;let draft=drafts.get(path);
   if(!draft){draft={...saved,error:''};drafts.set(path,draft);}else if(draft.revision!==saved.revision){draft.latest=saved;draft.error='This note changed while you were editing. Review the latest version; your draft is preserved.';}
   if(draft.saving){api.notice('This note is still being saved.');return;}draw(draft);
  }catch(error){api.notice(error.message);}
 }
 window.RUContent={init(callbacks){api=callbacks;document.addEventListener('click',event=>{const button=event.target.closest('[data-content-edit]');if(button&&!button.disabled){event.preventDefault();edit(button.dataset.contentEdit);}});},edit};
})();
