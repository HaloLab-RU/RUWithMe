(()=>{
 let api,library,current=null,turn=0;
 const esc=value=>api.escape(value);
 async function open({path,data,url}){
  const token=++turn;if(current){current.task?.cancel();current.pdf?.destroy();current=null;}
  api.dialog(path.split('/').at(-1),`<div class="pdf-reader"><div class="pdf-toolbar"><div class="page-actions"><button class="button" data-pdf-prev disabled aria-label="Previous PDF page">←</button><output data-pdf-page aria-live="polite">Loading PDF…</output><button class="button" data-pdf-next disabled aria-label="Next PDF page">→</button></div><label class="pdf-zoom">Zoom <select data-pdf-zoom aria-label="PDF zoom"><option value="fit">Fit width</option><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option></select></label><a class="text-button" href="${esc(url)}" download="${esc(path.split('/').at(-1))}">Download original ↓</a></div><p class="small" data-pdf-status role="status">Rendering the original file locally…</p><div class="pdf-scroll"><canvas aria-label="PDF page" role="img"></canvas></div><details class="pdf-page-text"><summary>Read page text</summary><p></p></details></div>`);
  const reader=document.querySelector('.pdf-reader'),canvas=reader.querySelector('canvas'),output=reader.querySelector('[data-pdf-page]'),status=reader.querySelector('[data-pdf-status]'),zoom=reader.querySelector('[data-pdf-zoom]');
  try{
   library ||= import('/vendor/pdf.mjs');const pdfjs=await library;pdfjs.GlobalWorkerOptions.workerSrc='/vendor/pdf.worker.mjs';
   const pdf=await pdfjs.getDocument({data,isEvalSupported:false,enableXfa:false}).promise;
   if(token!==turn||!reader.isConnected){await pdf.destroy();return;}
   let page=1;const key='ruwithme.reader.'+path+'.'+pdf.fingerprints[0];
   try{const saved=JSON.parse(localStorage.getItem(key));if(Number.isInteger(saved?.page))page=Math.max(1,Math.min(pdf.numPages,saved.page));if(['fit','1','1.25','1.5'].includes(saved?.zoom))zoom.value=saved.zoom;}catch{}
   current={pdf,task:null};let working=false;
   async function paint(){
    if(working||token!==turn||!reader.isConnected)return;working=true;const prev=reader.querySelector('[data-pdf-prev]'),next=reader.querySelector('[data-pdf-next]');prev.disabled=true;next.disabled=true;zoom.disabled=true;
    try{const original=await pdf.getPage(page),base=original.getViewport({scale:1}),scale=zoom.value==='fit'?Math.min(1.4,Math.max(.25,(reader.querySelector('.pdf-scroll').clientWidth-34)/base.width)):Number(zoom.value),viewport=original.getViewport({scale}),density=Math.min(2,devicePixelRatio||1),context=canvas.getContext('2d');canvas.width=Math.ceil(viewport.width*density);canvas.height=Math.ceil(viewport.height*density);canvas.style.width=viewport.width+'px';canvas.style.height=viewport.height+'px';
     const task=original.render({canvasContext:context,viewport,transform:density===1?null:[density,0,0,density,0,0]});current.task=task;await task.promise;
     if(token!==turn||!reader.isConnected)return;output.textContent=`Page ${page} of ${pdf.numPages}`;canvas.setAttribute('aria-label',`PDF page ${page} of ${pdf.numPages}`);status.textContent='Original PDF · Reading position is remembered in this browser.';const text=await original.getTextContent();reader.querySelector('.pdf-page-text p').textContent=text.items.map(item=>item.str).join(' ');try{localStorage.setItem(key,JSON.stringify({page,zoom:zoom.value}));}catch{}
    }catch(error){if(error.name!=='RenderingCancelledException')status.textContent='Could not render this page. Download the original to continue.';}
    finally{working=false;prev.disabled=page<=1;next.disabled=page>=pdf.numPages;zoom.disabled=false;}
   }
   reader.querySelector('[data-pdf-prev]').onclick=()=>{page=Math.max(1,page-1);paint();};reader.querySelector('[data-pdf-next]').onclick=()=>{page=Math.min(pdf.numPages,page+1);paint();};zoom.onchange=paint;await paint();
  }catch(error){status.textContent='The PDF could not be rendered: '+error.message+'. Download original remains available.';output.textContent='Preview unavailable';}
 }
 window.RUPDF={open,init(callbacks){api=callbacks;document.getElementById('dialog').addEventListener('close',()=>{turn++;current?.task?.cancel();current?.pdf?.destroy();current=null;});}};
})();
