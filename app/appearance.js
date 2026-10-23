// Apply the saved text size before styles load, then wire the global control.
(()=>{
 'use strict';
 const key='ruwithme.textSize',min=90,max=150,step=10;
 const normalize=value=>{
  const number=Number(value);
  return Number.isInteger(number)&&number>=min&&number<=max&&number%step===0?number:100;
 };
 let size=100,persistent=true;
 try{size=normalize(localStorage.getItem(key));}catch{persistent=false;}
 const apply=()=>document.documentElement.style.setProperty('--text-scale',String(size/100));
 apply();
 document.addEventListener('DOMContentLoaded',()=>{
  const menu=document.querySelector('#text-size-menu');
  if(!menu)return;
  const trigger=menu.querySelector('summary'),output=menu.querySelector('output');
  const smaller=menu.querySelector('[data-text-size="smaller"]');
  const larger=menu.querySelector('[data-text-size="larger"]');
  const reset=menu.querySelector('[data-text-size="reset"]');
  const note=menu.querySelector('.text-size-note');
  function render(){
   output.textContent=size+'%';
   smaller.disabled=size===min;larger.disabled=size===max;reset.disabled=size===100;
   trigger.title='Text size ('+size+'%)';
   note.textContent=persistent?'Saved in this browser.':'Applies here; browser storage is unavailable.';
  }
  function change(value){
   size=normalize(value);apply();
   try{localStorage.setItem(key,String(size));persistent=true;}catch{persistent=false;}
   render();
  }
  smaller.addEventListener('click',()=>change(size-step));
  larger.addEventListener('click',()=>change(size+step));
  reset.addEventListener('click',()=>change(100));
  document.addEventListener('pointerdown',event=>{if(!menu.contains(event.target))menu.open=false;});
  document.addEventListener('keydown',event=>{
   if(event.key==='Escape'&&menu.open){menu.open=false;trigger.focus();event.preventDefault();}
  });
  window.addEventListener('storage',event=>{
   if(event.key===key||event.key===null){size=normalize(event.newValue);apply();render();}
  });
  render();
 });
})();
