(function(root,factory){
 'use strict';
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 if(root)root.RUDaily=api;
})(typeof window==='undefined'?null:window,function(){
 'use strict';
 const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
 const contentRoots=new Set(['research','courses','learn','career','admin','personal','inbox']);
 function localContentPath(value,{workspaceRoot=''}={}){
  if(typeof value!=='string'||/[\u0000-\u001f\u007f\\]/.test(value))return null;
  let path=value.trim().replace(/:\d+(?::\d+)?$/,'');
  try{path=decodeURIComponent(path);}catch{return null;}
  if(workspaceRoot&&path.startsWith(workspaceRoot.replace(/\/$/,'')+'/'))path=path.slice(workspaceRoot.replace(/\/$/,'').length+1);
  else if(path.startsWith('/'))return null;
  if(path.startsWith('workspace/'))path=path.slice(10);
  const parts=path.split('/');
  if(!contentRoots.has(parts[0])||parts.length<2||parts.some(part=>!part||part==='.'||part==='..'||part.startsWith('.'))||/[?#\u0000-\u001f\u007f\\]/.test(path))return null;
  return path;
 }
 function safeLink(value,options={}){
  if(typeof value!=='string')return null;
  const href=value.trim();
  if(!href||/[\u0000-\u001f\u007f]/.test(href))return null;
  const path=localContentPath(href,options);if(path)return{kind:'preview',path};
  try{const url=new URL(href);if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password)return{kind:'external',href:url.href};}catch{}
  return null;
 }
 function linkMarkup(label,target,options){
  const link=safeLink(target,options);if(!link)return label;
  return link.kind==='preview'?`<button type="button" class="daily-content-link" data-daily-preview="${escape(link.path)}">${label}</button>`:`<a href="${escape(link.href)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${label}</a>`;
 }
 function inlineMarkdown(value,options={},depth=0){
  const text=String(value??'');let html='',index=0;
  if(depth>5)return escape(text);
  while(index<text.length){
   const rest=text.slice(index);
   if(rest.startsWith('`')){
    const run=rest.match(/^`+/)[0],end=text.indexOf(run,index+run.length);
    if(end>=0){html+='<code>'+escape(text.slice(index+run.length,end).replace(/\n/g,' '))+'</code>';index=end+run.length;continue;}
   }
   const image=rest.startsWith('!['),offset=image?1:0;
   if(rest[offset]==='['){
    const endLabel=text.indexOf('](',index+offset+1);
    if(endLabel>=0){
     let end=endLabel+2,balance=1;
     for(;end<text.length&&balance;end++){if(text[end]==='(')balance++;else if(text[end]===')')balance--;if(text[end]==='\n')break;}
     if(balance===0){let target=text.slice(endLabel+2,end-1).trim();if(target.startsWith('<')&&target.endsWith('>'))target=target.slice(1,-1);target=target.replace(/\s+["'][^"']*["']$/,'');const label=inlineMarkdown(text.slice(index+offset+1,endLabel),options,depth+1);html+=linkMarkup((image?'Image: ':'')+label,target,options);index=end;continue;}
    }
   }
   const marker=rest.startsWith('**')?'**':rest.startsWith('__')?'__':rest[0]==='*'?'*':rest[0]==='_'?'_':null;
   if(marker){const end=text.indexOf(marker,index+marker.length);if(end>index+marker.length){const tag=marker.length===2?'strong':'em';html+=`<${tag}>${inlineMarkdown(text.slice(index+marker.length,end),options,depth+1)}</${tag}>`;index=end+marker.length;continue;}}
   const auto=rest.match(/^https?:\/\/[^\s<>"'`]+/i);
   if(auto){const href=auto[0].replace(/[.,;!?, .; ！？)\]]+$/,'');html+=linkMarkup(escape(href),href,options);index+=href.length;continue;}
   if(text[index]==='\\'&&/[`*_\[\]\\]/.test(text[index+1]||'')){html+=escape(text[index+1]);index+=2;continue;}
   html+=text[index]==='\n'?'<br>':escape(text[index]);index++;
  }
  return html;
 }
 function tableCells(line){return line.trim().replace(/^\|/,'').replace(/\|$/,'').split(/(?<!\\)\|/).map(cell=>cell.trim().replace(/\\\|/g,'|'));}
 function tableDivider(line){const cells=tableCells(line);return cells.length>0&&cells.every(cell=>/^:?-{3,}:?$/.test(cell));}
 function renderMarkdown(value,options={},depth=0){
  if(depth>8)return '<p>'+escape(value)+'</p>';
  const lines=String(value??'').replace(/\r\n?/g,'\n').split('\n');let html='',index=0;
  const blockStart=line=>/^\s*(?:#{1,6}\s|```|~~~|>|[-+*]\s|\d+[.)]\s|(?:[-*_]\s*){3,}$)/.test(line);
  while(index<lines.length){
   const line=lines[index];if(!line.trim()){index++;continue;}
   const fence=line.match(/^\s*(`{3,}|~{3,})([^\s`]*)[^\n]*$/);
   if(fence){const code=[],token=fence[1],language=fence[2];index++;while(index<lines.length&&!new RegExp('^\\s*'+token[0]+'{'+token.length+',}\\s*$').test(lines[index]))code.push(lines[index++]);if(index<lines.length)index++;html+=`<div class="daily-code-block">${language?`<span class="daily-code-language">${escape(language)}</span>`:''}<pre><code>${escape(code.join('\n'))}</code></pre></div>`;continue;}
   const heading=line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
   if(heading){const level=Math.min(heading[1].length+1,6);html+=`<h${level}>${inlineMarkdown(heading[2],options)}</h${level}>`;index++;continue;}
   if(/^\s*(?:[-*_]\s*){3,}$/.test(line)){html+='<hr>';index++;continue;}
   if(/^\s*>/.test(line)){const quote=[];while(index<lines.length&&/^\s*>/.test(lines[index]))quote.push(lines[index++].replace(/^\s*>\s?/,''));html+='<blockquote>'+renderMarkdown(quote.join('\n'),options,depth+1)+'</blockquote>';continue;}
   if(index+1<lines.length&&line.includes('|')&&tableDivider(lines[index+1])){
    const headers=tableCells(line),rows=[];index+=2;while(index<lines.length&&lines[index].includes('|')&&lines[index].trim())rows.push(tableCells(lines[index++]));
    html+='<div class="daily-table-scroll"><table><thead><tr>'+headers.map(cell=>'<th scope="col">'+inlineMarkdown(cell,options)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+headers.map((_,column)=>'<td>'+inlineMarkdown(row[column]||'',options)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';continue;
   }
   const list=line.match(/^\s*([-+*]|\d+[.)])\s+(.*)$/);
   if(list){const ordered=/^\d/.test(list[1]),tag=ordered?'ol':'ul',entries=[];let start=ordered?parseInt(list[1],10):1;
    while(index<lines.length){const entry=lines[index].match(/^\s*([-+*]|\d+[.)])\s+(.*)$/);if(!entry||/^\d/.test(entry[1])!==ordered)break;let content=entry[2];index++;while(index<lines.length&&/^\s{2,}\S/.test(lines[index])&&!blockStart(lines[index]))content+='\n'+lines[index++].trim();entries.push('<li>'+inlineMarkdown(content,options)+'</li>');}
    html+=`<${tag}${ordered&&start!==1?' start="'+start+'"':''}>${entries.join('')}</${tag}>`;continue;
   }
   const paragraph=[line];index++;while(index<lines.length&&lines[index].trim()&&!blockStart(lines[index])&&!(index+1<lines.length&&lines[index].includes('|')&&tableDivider(lines[index+1])))paragraph.push(lines[index++]);
   html+='<p>'+inlineMarkdown(paragraph.join('\n'),options)+'</p>';
  }
  return html;
 }
 function normalizeQuestions(questions){return(Array.isArray(questions)?questions:[]).map((question,index)=>({id:String(question.id??'question-'+index),header:String(question.header||''),question:String(question.question||''),isOther:question.isOther===true,isSecret:question.isSecret===true,options:Array.isArray(question.options)?question.options.filter(option=>option&&typeof option.label==='string').map(option=>({label:option.label,description:String(option.description||'')})):[]}));}
 function answerPayload(questions,values){
  const answers={};for(const question of normalizeQuestions(questions)){const value=values[question.id];if(typeof value!=='string'||!value.trim())throw new Error('Answer every question.');if(value.length>4000)throw new Error('Each answer can contain up to 4,000 characters.');answers[question.id]={answers:[value]};}return{answers};
 }
 function shouldSubmitEnter(event,{composing=false,lastCompositionEnd=0,now=Date.now()}={}){return event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229&&!composing&&now-lastCompositionEnd>80;}
 function statusLabel(status){return({inProgress:'In progress',running:'In progress',completed:'Completed',succeeded:'Completed',failed:'Failed',error:'Failed',declined:'Declined',interrupted:'Stopped',cancelled:'Cancelled'})[status]||String(status||'Waiting');}
 const stableJSON=value=>{try{return JSON.stringify(value,null,2);}catch{return String(value??'');}};
 let callbacks=null,session=null,syncPending=null,pollTimer=null,initialized=false,sending=false,stopping=false,switching=false,composing=false,lastCompositionEnd=0,draftVersion=0,sendAttempt=null,transportError='',wasActive=false;
 let elements={},transcript=null,timeline=null,timelineList=null,timelineSummary=null,timelineNote=null,requestsList=null,welcome=null;
 const messageViews=new Map(),activityViews=new Map(),requestViews=new Map();
 function element(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
 function reconcile(parent,nodes){const keep=new Set(nodes);for(const child of [...parent.children])if(!keep.has(child))child.remove();nodes.forEach((node,index)=>{if(parent.children[index]!==node)parent.insertBefore(node,parent.children[index]||null);});}
 function open(){if(!initialized)return;elements.shell.classList.add('daily-open');elements.input.focus();}
 function prepare(text){if(!initialized)return;const value=String(text??'');if(elements.input.value.trim()&&elements.input.value!==value)elements.input.value+='\n\n'+value;else if(!elements.input.value.trim())elements.input.value=value;draftVersion++;open();elements.input.setSelectionRange(elements.input.value.length,elements.input.value.length);paintControls();}
 function getState(){return session;}
 function isBusy(){return sending||stopping||switching;}
 function schedule(){clearTimeout(pollTimer);if(!initialized)return;pollTimer=setTimeout(()=>{if(!document.hidden||session?.active||session?.requests?.length)sync();else schedule();},session?.active||session?.requests?.length?1000:15000);}
 function sync(){
  if(syncPending)return syncPending;
  syncPending=(async()=>{try{const response=await fetch('/api/codex/session'),data=await response.json();if(!response.ok)throw new Error(data.error||'Could not read Codex status.');acceptSession(data);transportError='';paintControls();return session;}catch(error){transportError='Codex connection unavailable: '+error.message;paintControls();return session;}finally{syncPending=null;schedule();}})();return syncPending;
 }
 function acceptSession(next){
  if(!next||typeof next!=='object')return;
  if(session&&next.csrf===session.csrf&&Number.isFinite(next.revision)&&Number.isFinite(session.revision)&&next.revision<session.revision)return;
  const finished=wasActive&&!next.active;session=next;wasActive=!!next.active;paint();callbacks.onSession?.(next);if(finished)Promise.resolve(callbacks.refresh()).catch(()=>{});
 }
 function paintControls(){
  if(!initialized)return;const connected=!!session?.account,active=!!session?.active,pending=session?.requests?.length||0;
  elements.status.textContent=connected?'Codex · '+(session.account.plan||'Connected'):'Codex · Connect';elements.status.title=session?.model||'Your Codex connection';
  elements.send.disabled=sending||switching||!!callbacks.isBusy?.()||!connected||!elements.input.value.trim();elements.send.setAttribute('aria-label',active?'Add instructions':'Send message');elements.send.title=active?'Add instructions to the running task':'Send message';elements.send.textContent=active?'↗':'↑';
  elements.input.placeholder=active?'Daily is working. Add more instructions here…':'Discuss your work or move it forward with Daily…';
  elements.newConversation.disabled=switching||sending||stopping||active||!!pending||!!callbacks.isBusy?.();elements.newConversation.textContent=switching?'Switching…':'New chat';elements.restoreConversation.hidden=!session?.hasPreviousConversation;elements.restoreConversation.disabled=elements.newConversation.disabled;
  elements.stop.hidden=!active;elements.stop.disabled=stopping;elements.stop.textContent=stopping?'Stopping…':'Stop task';
  elements.progress.textContent=transportError||session?.error||(sending?(active?'Sending additional instructions…':'Sending…'):pending?'Daily is waiting for your response.':active?'Daily is working. You can send additional instructions.':'');
  elements.progress.classList.toggle('daily-has-error',!!(transportError||session?.error));
  const footnote=elements.daily.querySelector('.daily-footnote');if(footnote){footnote.textContent=session?.access?.mode==='project-write'?'Your Codex subscription · RUWithMe project access':'Your Codex subscription · Your workspace files';footnote.title=session?.access?.writableRoot||session?.projectRoot||session?.workspaceRoot||'';}
 }
 function messageNode(message,index){
  const id=String(message.id??message.role+':'+index);let view=messageViews.get(id);
  if(!view){const root=element('article','chat-message daily-message '+(message.role==='user'?'user':'assistant')),label=element('span','daily-message-author',message.role==='user'?'You':'Daily'),body=element('div','daily-rich'),delivery=element('p','daily-delivery');delivery.hidden=true;root.append(label,body,delivery);view={root,body,delivery,text:null,renderKey:''};messageViews.set(id,view);}
  const text=String(message.text||''),renderKey=String(session?.workspaceRoot||'');
  if(view.text!==text||view.renderKey!==renderKey){
   const selection=typeof window.getSelection==='function'?window.getSelection():null;
   if(!selection||selection.isCollapsed||!view.body.contains(selection.anchorNode)){if(message.role==='user'){view.body.textContent=text;view.body.classList.add('daily-user-text');}else view.body.innerHTML=renderMarkdown(text,{workspaceRoot:session?.workspaceRoot||''});view.text=text;view.renderKey=renderKey;}
  }
  const delivery=message.role==='user'?message.delivery:null;view.delivery.hidden=!['pending','failed','unknown'].includes(delivery);view.delivery.dataset.state=delivery||'';view.delivery.textContent=delivery==='pending'?'Sending…':delivery==='failed'?'Send failed: '+(message.deliveryError||'Your draft is preserved. You can try again.'):delivery==='unknown'?'Delivery not confirmed: '+(message.deliveryError||'Review the response first. Your draft is preserved.'):'';
  return view.root;
 }
 function activityNode(activity,index){
  const id=String(activity.id??'activity-'+index);let view=activityViews.get(id);
  if(!view){const root=element('li','daily-activity-item'),details=element('details','daily-tool'),summary=element('summary'),state=element('span','daily-tool-state'),title=element('span','daily-tool-title'),body=element('div','daily-tool-body');summary.append(state,title);details.append(summary,body);root.append(details);view={root,details,state,title,body,blocks:new Map(),signature:''};activityViews.set(id,view);}
  const stopped=['interrupted','cancelled'].includes(activity.status)||activity.type==='interaction'&&/^Stopped\./.test(activity.error||'');
  const failed=!stopped&&(['failed','error'].includes(activity.status)||!!activity.error),state=['inProgress','running'].includes(activity.status)?'running':failed?'failed':'done';
  view.root.dataset.status=state;view.state.textContent=statusLabel(stopped?'interrupted':failed?'failed':activity.status);view.title.textContent=stopped?'Task stopped':activity.title||activity.tool||activity.type||'Working';
  const signature=stableJSON(activity);if(signature!==view.signature){const blocks=[],add=(title,value,kind='')=>{if(value===undefined||value===null||value==='')return;const key=title+'|'+kind;let block=view.blocks.get(key);if(!block){const section=element('div','daily-tool-section '+kind),pre=element('pre');section.append(element('h4','',title),pre);block={section,pre,value:''};view.blocks.set(key,block);}const text=typeof value==='string'?value:stableJSON(value);if(block.value!==text){const top=block.pre.scrollTop,left=block.pre.scrollLeft,follow=block.pre.scrollHeight-block.pre.scrollTop-block.pre.clientHeight<30;if(text.startsWith(block.value)&&block.pre.firstChild?.nodeType===3)block.pre.firstChild.appendData(text.slice(block.value.length));else block.pre.textContent=text;block.value=text;block.pre.scrollTop=follow?block.pre.scrollHeight:top;block.pre.scrollLeft=left;}blocks.push(block.section);};
   if(activity.server||activity.tool)add('Connected tool',[activity.server,activity.tool].filter(Boolean).join(' · '));
   add('Command',activity.command||activity.detail);if(activity.cwd)add('Directory',activity.cwd);
   if(activity.query)add('Search',activity.query);if(Array.isArray(activity.changes))for(const change of activity.changes)add(String(change.path||'File change')+(change.kind?' · '+change.kind:''),change.diff||'File updated.','daily-diff');
   add('Output',activity.output);add(stopped?'Result':'Error',activity.error,stopped?'daily-tool-note':'daily-tool-error');
   if(activity.exitCode!==undefined&&activity.exitCode!==null)blocks.push(element('p','daily-tool-note','Exit code: '+activity.exitCode));
   if(activity.truncated)blocks.push(element('p','daily-tool-note','This display is truncated; the original result remains in the model conversation.'));
   if(!blocks.length)blocks.push(element('p','daily-tool-note',state==='running'?'Working…':'No additional output.'));
   reconcile(view.body,blocks);view.signature=signature;
  }
  return view.root;
 }
 function questionFields(view,question,index){
  const fieldset=element('fieldset','daily-question'),legend=element('legend','',question.header||'Question '+(index+1));fieldset.append(legend,element('p','daily-question-prompt',question.question));
  const record={question,fieldset,radios:[],other:null,free:null},name='daily-answer-'+view.id+'-'+index;
  const input=(secret=false)=>{const field=element(secret?'input':'textarea','daily-answer-field');if(secret)field.type='password';else field.rows=2;field.maxLength=4000;field.autocomplete='off';field.setAttribute('aria-label',question.question||question.header||'Answer');field.setAttribute('data-lpignore','true');return field;};
  if(question.options.length){
   question.options.forEach((option,optionIndex)=>{const row=element('label','daily-choice'),radio=element('input'),text=element('span','daily-choice-text');radio.type='radio';radio.name=name;radio.value=option.label;radio.required=true;radio.id=name+'-'+optionIndex;text.append(element('strong','',option.label));if(option.description)text.append(element('small','',option.description));row.append(radio,text);fieldset.append(row);record.radios.push(radio);});
   if(question.isOther){const row=element('label','daily-choice'),radio=element('input');radio.type='radio';radio.name=name;radio.value='__daily_other__';radio.required=true;row.append(radio,element('span','daily-choice-text','Write your own answer'));fieldset.append(row);record.radios.push(radio);record.other=radio;record.free=input(question.isSecret);record.free.placeholder=question.isSecret?'Enter a secret answer':'Enter your answer';record.free.disabled=true;record.free.hidden=true;fieldset.append(record.free);}
   for(const radio of record.radios)radio.addEventListener('change',()=>{if(record.free){record.free.hidden=!record.other.checked;record.free.disabled=view.saving||!record.other.checked;record.free.required=record.other.checked;if(record.other.checked)record.free.focus();}});
  }else{record.free=input(question.isSecret);record.free.required=true;fieldset.append(record.free);}
  if(question.isSecret)fieldset.append(element('p','daily-secret-note','Secret input is not shown in plain text. Your answer is sent to the current Codex conversation.'));
  view.fields.push(record);return fieldset;
 }
 function buildRequest(request){
  const id=String(request.id),root=element('form','daily-request'),title=element('h3'),description=element('p','daily-request-reason'),body=element('div','daily-request-body'),error=element('p','daily-request-error'),actions=element('div','daily-request-actions');root.dataset.dailyRequest=id;error.setAttribute('role','alert');
  const view={id,root,title,description,body,error,actions,request,fields:[],saving:false,buttons:[]};root.append(title,description,body,error,actions);
  if(String(request.method).includes('requestUserInput')){
   title.textContent='Daily Your input is needed';for(const [index,question] of normalizeQuestions(request.questions).entries())body.append(questionFields(view,question,index));
   const submit=element('button','button primary','Send answer');submit.type='submit';actions.append(submit);view.buttons.push(submit);
   root.addEventListener('submit',event=>{event.preventDefault();event.stopPropagation();if(view.saving)return;try{const values={};for(const field of view.fields){const selected=field.radios.find(radio=>radio.checked);values[field.question.id]=field.radios.length?(selected===field.other?field.free.value:selected?.value):field.free.value;}submitAnswer(view,answerPayload(request.questions,values));}catch(failure){error.textContent=failure.message;}});
  }else{
   const permissions=String(request.method).includes('permissions'),network=!!request.networkApprovalContext||request.permissions?.network?.enabled===true||request.additionalPermissions?.network?.enabled===true;
   title.textContent=permissions?'Review access request':network?'Review network access and command':'Review this action';body.append(element('p','daily-approval-scope','Waiting for your approval or refusal. Access applies only to this task.'));
   if(request.command)body.append(element('pre','daily-approval-command',Array.isArray(request.command)?request.command.join(' '):request.command));
   const detailsData={};for(const key of ['cwd','permissions','additionalPermissions','networkApprovalContext'])if(request[key]!==undefined&&request[key]!==null&&request[key]!=='')detailsData[key]=request[key];
   if(Object.keys(detailsData).length){const details=element('details','daily-permission-details');details.open=true;details.append(element('summary','','View requested access'),element('pre','',stableJSON(detailsData)));body.append(details);}
   const approve=element('button','button primary','Allow for this task'),decline=element('button','button','Decline');approve.type=decline.type='button';approve.disabled=request.canApprove===false;
   if(request.canApprove===false)body.append(element('p','daily-request-unsupported',request.unsupportedReason||'This request cannot be approved within the current workspace. Decline it and ask Daily to adjust the approach.'));
   approve.addEventListener('click',()=>{if(!view.saving&&view.request.canApprove!==false)submitAnswer(view,{decision:'accept'});});decline.addEventListener('click',()=>{if(!view.saving)submitAnswer(view,{decision:'decline'});});actions.append(approve,decline);view.buttons.push(approve,decline);
   root.addEventListener('submit',event=>{event.preventDefault();event.stopPropagation();});
  }
  description.textContent=request.reason||'';description.hidden=!request.reason;return view;
 }
 async function submitAnswer(view,payload){
  view.saving=true;view.error.textContent='';for(const button of view.buttons)button.disabled=true;for(const field of view.fields){for(const radio of field.radios)radio.disabled=true;if(field.free)field.free.disabled=true;}
  try{const result=await callbacks.post('/api/codex/answer',{id:view.id,...payload});acceptSession(result);schedule();}
  catch(error){view.error.textContent=error.message;}
  finally{view.saving=false;if(requestViews.has(view.id)){for(const button of view.buttons)button.disabled=button===view.buttons[0]&&view.request.canApprove===false;for(const field of view.fields){for(const radio of field.radios)radio.disabled=false;if(field.free)field.free.disabled=!!field.radios.length&&!field.other?.checked;}}}
 }
 function paint(){
  if(!initialized)return;const nearBottom=elements.messages.scrollHeight-elements.messages.scrollTop-elements.messages.clientHeight<100,scrollTop=elements.messages.scrollTop,messages=Array.isArray(session?.messages)?session.messages:[],activities=Array.isArray(session?.activity)?session.activity:[],requests=Array.isArray(session?.requests)?session.requests:[];
  const nodes=messages.map(messageNode);reconcile(transcript,nodes);const messageIds=new Set(messages.map((message,index)=>String(message.id??message.role+':'+index)));for(const id of messageViews.keys())if(!messageIds.has(id))messageViews.delete(id);
  welcome.hidden=!!messages.length;
  reconcile(timelineList,activities.map(activityNode));timeline.hidden=!activities.length;timelineNote.hidden=!session?.activityTruncated;const activeCount=activities.filter(activity=>['inProgress','running'].includes(activity.status)).length;timelineSummary.textContent='Execution · '+activities.length+(activeCount?' · '+activeCount+' In progress':'');const activityIds=new Set(activities.map((activity,index)=>String(activity.id??'activity-'+index)));for(const id of activityViews.keys())if(!activityIds.has(id))activityViews.delete(id);
  const cards=requests.map(request=>{const id=String(request.id);let view=requestViews.get(id);if(!view){view=buildRequest(request);requestViews.set(id,view);}view.request=request;return view.root;});reconcile(requestsList,cards);const requestIds=new Set(requests.map(request=>String(request.id)));for(const id of requestViews.keys())if(!requestIds.has(id))requestViews.delete(id);
  paintControls();const focusedRequest=requestsList.contains(document.activeElement);if(nearBottom&&!focusedRequest)elements.messages.scrollTop=elements.messages.scrollHeight;else elements.messages.scrollTop=scrollTop;
 }
 async function send(event){
  event.preventDefault();event.stopPropagation();const text=elements.input.value.trim();if(!text||sending||callbacks.isBusy?.())return;if(text.length>12000){callbacks.notice('Split your message into shorter parts.');return;}if(!session?.account){callbacks.notice('Check Codex connection.');return;}
  const value=elements.input.value,version=draftVersion,active=!!session.active,kind=active?'steer':'turn';
  if(!sendAttempt||sendAttempt.text!==text||sendAttempt.kind!==kind)sendAttempt={text,kind,requestId:crypto.randomUUID(),expectedTurnId:session.activeTurnId};
  const attempt=sendAttempt;sending=true;transportError='';paintControls();
  try{const context=callbacks.context?.()||'',result=await callbacks.post('/api/codex/'+kind,{text,context,requestId:attempt.requestId,...(active&&attempt.expectedTurnId?{expectedTurnId:attempt.expectedTurnId}:{})});acceptSession(result);if(elements.input.value===value&&draftVersion===version){elements.input.value='';draftVersion++;}sendAttempt=null;}
  catch(error){transportError=error.message;callbacks.notice(error.message);}
  finally{sending=false;paintControls();schedule();}
 }
 async function switchConversation(restore=false){
  if(switching||sending||stopping||session?.active||session?.requests?.length||callbacks.isBusy?.())return;
  switching=true;paintControls();const expectedRevision=session?.revision;
  try{const next=await callbacks.post('/api/codex/'+(restore?'restore-conversation':'new-conversation'),{expectedRevision});sendAttempt=null;draftVersion++;transportError='';acceptSession(next);callbacks.notice(restore?'Restored the previous Daily conversation.':'Started a new conversation. You can restore the previous chat; workspace and Track records are preserved.');elements.input.focus();}
  catch(error){transportError=error.message;callbacks.notice(error.message);await sync();}
  finally{switching=false;paintControls();callbacks.onSession?.(session);schedule();}
 }
 async function stop(){if(stopping)return;stopping=true;paintControls();try{acceptSession(await callbacks.post('/api/codex/stop',{}));await sync();}catch(error){transportError=error.message;callbacks.notice(error.message);}finally{stopping=false;paintControls();}}
 function connection(){
  const account=session?.account,access=session?.access,root=session?.projectRoot||access?.writableRoot||session?.workspaceRoot;
  callbacks.dialog('Your Codex connection',`<p>${account?'Connected to ChatGPT through local Codex: '+escape(account.plan||'subscription')+'.':'Sign in to Codex on this computer, then check the connection.'}</p><p><strong>Model</strong><br>${escape(session?.model||'Use the configured Codex model')}</p>${root?`<p><strong>${access?.mode==='project-write'?'Project access':'Workspace access'}</strong><br><code>${escape(root)}</code></p>`:''}<p class="small">Daily keeps its own conversation and does not import other chats. Review permission and network requests in this panel.</p>`);
 }
 function init(options){
  if(initialized)return{sync,prepare,open,getState,isBusy};callbacks=options||{};
  const find=id=>document.getElementById(id);elements={shell:document.querySelector('.shell'),daily:document.querySelector('.daily'),messages:find('messages'),input:find('chat-input'),form:find('chat-form'),send:find('send-message'),progress:find('daily-progress'),status:find('codex-status'),stop:find('stop-daily'),check:find('check-daily'),open:find('open-daily'),close:find('close-daily'),newConversation:find('new-daily'),restoreConversation:find('restore-daily')};
  if(Object.values(elements).some(value=>!value))throw new Error('Daily chat elements are missing.');
  welcome=element('div','welcome daily-welcome');welcome.append(element('strong','','Hi, I am Daily.'),element('p','','Discuss courses, research, and materials, or ask me to help maintain your workspace.'));
  transcript=element('div','daily-transcript');timeline=element('details','daily-timeline');timeline.open=true;timelineSummary=element('summary','','Execution');timelineList=element('ol','daily-activity-list');timelineNote=element('p','daily-tool-note','The execution display is bounded; this does not delete the model\'s conversation history.');timelineNote.hidden=true;timeline.append(timelineSummary,timelineList,timelineNote);requestsList=element('div','daily-requests');elements.messages.replaceChildren(welcome,transcript,timeline,requestsList);
  initialized=true;
  elements.daily.addEventListener('click',event=>{const node=event.target;if(node.closest('#track-review')||event.composedPath().some(part=>part.getAttributeNames?.().some(name=>name.startsWith('data-track-'))))return;const target=node.closest('[data-daily-preview]');if(node.closest('.daily-transcript,.daily-timeline,.daily-requests,#chat-form')||[elements.close,elements.status,elements.stop,elements.check].some(button=>button.contains(node)))event.stopPropagation();if(target){event.preventDefault();Promise.resolve(callbacks.preview(target.dataset.dailyPreview)).catch(error=>callbacks.notice(error.message));}});
  elements.daily.addEventListener('submit',event=>{if(event.target===elements.form||event.target.closest('.daily-requests'))event.stopPropagation();});
  elements.open.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();open();});elements.close.addEventListener('click',()=>elements.shell.classList.remove('daily-open'));
  elements.form.addEventListener('submit',send);elements.input.addEventListener('input',()=>{draftVersion++;paintControls();});
  elements.input.addEventListener('compositionstart',()=>{composing=true;});elements.input.addEventListener('compositionend',()=>{composing=false;lastCompositionEnd=Date.now();draftVersion++;});elements.input.addEventListener('keydown',event=>{if(shouldSubmitEnter(event,{composing,lastCompositionEnd})){event.preventDefault();elements.form.requestSubmit();}});
  elements.newConversation.addEventListener('click',()=>switchConversation());elements.restoreConversation.addEventListener('click',()=>switchConversation(true));
  elements.stop.addEventListener('click',stop);elements.check.addEventListener('click',()=>sync());elements.status.addEventListener('click',connection);
  window.addEventListener('focus',()=>sync());document.addEventListener('visibilitychange',()=>{if(!document.hidden)sync();});document.addEventListener('selectionchange',()=>{const selection=window.getSelection();if(selection?.isCollapsed&&session)paint();});
  paint();sync();return{sync,prepare,open,getState,isBusy};
 }
 return{init,sync,prepare,open,getState,isBusy,helpers:{escape,localContentPath,safeLink,renderMarkdown,inlineMarkdown,normalizeQuestions,answerPayload,shouldSubmitEnter,statusLabel}};
});
