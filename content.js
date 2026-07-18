// Twitter/X SPA media opener
(function(){
'use strict';
if(window.__twMediaOrig)return;
window.__twMediaOrig=true;

const seen=new Set(); const MAX=100;
let observer=null,currentId=null,lastPath=location.pathname;

function idFromPath(p=location.pathname){const m=p.match(/\/status\/(\d+)/);return m&&m[1];}
function imgOrig(s){
 const u=new URL(s); u.searchParams.set('name','orig'); return u.href;
}
function mediaUrls(){
 const a=new Set();
 document.querySelectorAll('img[src*="pbs.twimg.com/media/"]').forEach(x=>a.add(imgOrig(x.src)));
 document.querySelectorAll('video').forEach(v=>{
  if(v.src && v.src.includes('video.twimg.com')) a.add(v.src);
  v.querySelectorAll('source').forEach(s=>s.src&&s.src.includes('video.twimg.com')&&a.add(s.src));
 });
 return a.size?a:null;
}
function mark(){
 seen.add(currentId);
 while(seen.size>MAX) seen.delete(seen.values().next().value);
}
function openMedia(){
 const urls=mediaUrls();
 if(!urls)return false;
 observer?.disconnect();
 mark();
 for(const u of urls) window.open(u,'_blank');
 setTimeout(()=>chrome.runtime.sendMessage({action:'closeTab'}),200);
 return true;
}
function setup(){
 observer?.disconnect();
 if(!document.body){requestAnimationFrame(setup);return;}
 observer=new MutationObserver(ms=>{
  for(const m of ms) for(const n of m.addedNodes){
   if(n.nodeType===1 && (n.matches?.('img,video,source') || n.querySelector?.('img[src*="pbs.twimg.com/media/"],video,source'))){
    if(openMedia()) return;
   }
  }
 });
 observer.observe(document.body,{childList:true,subtree:true});
 requestAnimationFrame(openMedia);
}
function check(){
 if(location.pathname===lastPath)return;
 lastPath=location.pathname;
 const id=idFromPath();
 if(id&&!seen.has(id)){currentId=id;setup();}
}
history.pushState=new Proxy(history.pushState,{apply(t,x,a){let r=Reflect.apply(t,x,a);check();return r;}});
history.replaceState=new Proxy(history.replaceState,{apply(t,x,a){let r=Reflect.apply(t,x,a);check();return r;}});
addEventListener('popstate',check);
currentId=idFromPath();
if(currentId)setup();
})();