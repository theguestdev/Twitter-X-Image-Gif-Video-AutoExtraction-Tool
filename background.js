// Twitter/X Media -> Original
(function(){
'use strict';
const SYNDICATION='https://cdn.syndication.twimg.com/tweet-result?id=';
const RECENT=new Map();

function extractId(url){
 try { const m=new URL(url).pathname.match(/\/status\/(\d+)/); return m?m[1]:null; } catch(e){return null;}
}
function cleanUrl(url){
 const u=new URL(url);
 u.searchParams.delete('name'); u.searchParams.delete('format');
 return u.href;
}
function origImage(url){
 const u=new URL(url);
 const base=u.origin+u.pathname;
 const ext=(u.pathname.match(/\.(\w+)$/)||[])[1]||'jpg';
 return base+'?format='+ext+'&name=orig';
}
function bestVideo(media){
 const vars=media.video_info && media.video_info.variants || [];
 return vars.filter(v=>v.url && (!v.content_type || v.content_type.includes('video')))
 .sort((a,b)=>(b.bitrate||0)-(a.bitrate||0))[0]?.url;
}
function shouldProcess(id){
 const t=RECENT.get(id);
 if(t && Date.now()-t<10000) return false;
 RECENT.set(id,Date.now());
 if(RECENT.size>50){
  const now=Date.now();
  for(const [k,v] of RECENT) if(now-v>60000) RECENT.delete(k);
 }
 return true;
}
async function handleTweet(id,tabId){
 try{
  const r=await fetch(SYNDICATION+id);
  if(!r.ok)return;
  const data=await r.json();
  const media=data.mediaDetails||[];
  const urls=[];
  for(const m of media){
   if(m.type==='photo') urls.push(origImage(m.media_url_https));
   else if(m.type==='video' || m.type==='animated_gif'){
    const v=bestVideo(m);
    if(v) urls.push(cleanUrl(v));
   }
  }
  if(!urls.length)return;
  await chrome.tabs.update(tabId,{url:urls[0]});
  for(let i=1;i<urls.length;i++) chrome.tabs.create({url:urls[i],active:false});
 }catch(e){}
}
chrome.webNavigation.onBeforeNavigate.addListener(d=>{
 if(d.frameId!==0)return;
 const id=extractId(d.url);
 if(id && shouldProcess(id)) handleTweet(id,d.tabId);
});
chrome.runtime.onMessage.addListener((msg,sender)=>{
 if(msg.action==='closeTab' && sender.tab) chrome.tabs.remove(sender.tab.id);
});
})();