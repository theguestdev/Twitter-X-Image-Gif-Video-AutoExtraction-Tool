// Twitter/X Media -> Original
// Background service worker.
//
// Sole authority for media URL extraction. Fetches tweet metadata from the
// public syndication API (cdn.syndication.twimg.com) and opens original-
// quality media URLs in background tabs via chrome.tabs.create.
//
// Performance design:
//   - Tab creation is fire-and-forget (all URLs opened in parallel, no await).
//   - The sender tab is closed directly from here (no message round-trip
//     back to the content script).
//   - HTTP cache is allowed (syndication responses are stable).
//   - Response is sent immediately after firing tab creation; the close
//     happens a moment later so the response has time to be delivered.
(function(){
'use strict';

// The syndication API REQUIRES a `token` query parameter — without it
// every video/GIF tweet returns 200 OK with an empty `{}` body (the original
// cause of "videos and gifs not working"). Any non-empty token value works;
// Twitter's own embed widget generates per-request tokens, but the endpoint
// does not currently validate them.
const SYNDICATION = 'https://cdn.syndication.twimg.com/tweet-result?id=';
const SYNDICATION_TOKEN = 'a';
const DEDUP_WINDOW_MS = 10000;   // ignore re-entries for the same tweet within 10s
const CLOSE_DELAY_MS = 30;       // small delay so sendResponse lands before tab dies
const recent = new Map();

// Rewrite a pbs.twimg.com image URL to its original-quality variant.
function origImage(url){
  if(!url) return null;
  try{
    const u = new URL(url);
    const base = u.origin + u.pathname;
    const ext = (u.pathname.match(/\.(\w+)$/)||[])[1] || 'jpg';
    return base + '?format=' + ext + '&name=orig';
  }catch(e){ return null; }
}

// Pick the highest-bitrate MP4 variant from a video_info block.
// Strict MP4 filter: HLS playlists (application/x-mpegURL) cannot be opened
// directly in a browser tab as a downloadable file, so we skip them entirely.
function bestVideo(media){
  const variants = (media.video_info && media.video_info.variants) || [];
  const mp4s = variants.filter(v => v.url && v.content_type === 'video/mp4');
  if(!mp4s.length) return null;
  // Highest bitrate first; missing bitrate falls to the end of the list.
  mp4s.sort((a,b) => (b.bitrate||0) - (a.bitrate||0));
  return mp4s[0].url;
}

// Dedup: if we've handled the same tweet ID within DEDUP_WINDOW_MS, skip it.
// This prevents duplicate tab openings from re-firing SPA navigation hooks
// (Twitter's router sometimes calls pushState/replaceState multiple times
// for the same logical navigation).
function shouldProcess(id){
  const t = recent.get(id);
  if(t && Date.now() - t < DEDUP_WINDOW_MS) return false;
  recent.set(id, Date.now());
  // Garbage-collect stale entries once the map grows past 100.
  if(recent.size > 100){
    const now = Date.now();
    for(const [k,v] of recent){
      if(now - v > 60000) recent.delete(k);
    }
  }
  return true;
}

// Collect original-quality media URLs from a single tweet's media array.
// Mutates the passed `urls` array.
function collectFromMedia(media, urls){
  if(!Array.isArray(media)) return;
  for(const m of media){
    if(!m) continue;
    // Some entries omit `type` but always include `video_info` for videos.
    const type = m.type || (m.video_info ? 'video' : 'photo');
    if(type === 'photo'){
      const u = origImage(m.media_url_https);
      if(u) urls.push(u);
    }else if(type === 'video' || type === 'animated_gif'){
      const v = bestVideo(m);
      if(v) urls.push(v);
    }
  }
}

// Fetch tweet metadata from the syndication API and return a list of
// original-quality media URLs (images and MP4s). Returns null if the API
// fails or the tweet has no extractable media.
//
// Handles three tweet shapes:
//   1. Direct media: tweet itself has images/video → data.mediaDetails
//      or data.media.all
//   2. Reply tweet: tweet itself has no media, but its parent (the tweet
//      it replies to) does → data.parent.mediaDetails. This is extremely
//      common on art accounts where the user opens a reply and expects
//      the parent's art to download.
//   3. Quote tweet: tweet itself has no media, but the quoted tweet does
//      → data.quotedStatus.mediaDetails (older API shape).
async function extractMediaUrls(id){
  const url = SYNDICATION + id + '&token=' + SYNDICATION_TOKEN + '&lang=en';
  const r = await fetch(url, {
    headers: { 'Accept': 'application/json' }
  });
  if(!r.ok) return null;
  const data = await r.json();
  if(!data || !Object.keys(data).length) return null; // empty `{}` body

  const urls = [];

  // 1. Direct media on this tweet.
  collectFromMedia(data.mediaDetails, urls);
  if(!urls.length && data.media){
    collectFromMedia(data.media.all, urls);
  }

  // 2. Reply tweet — media is on the parent.
  if(!urls.length && data.parent){
    collectFromMedia(data.parent.mediaDetails, urls);
    if(!urls.length && data.parent.media){
      collectFromMedia(data.parent.media.all, urls);
    }
  }

  // 3. Quote tweet — media is on the quoted status.
  if(!urls.length && data.quotedStatus){
    collectFromMedia(data.quotedStatus.mediaDetails, urls);
    if(!urls.length && data.quotedStatus.media){
      collectFromMedia(data.quotedStatus.media.all, urls);
    }
  }

  return urls.length ? urls : null;
}

// Open a list of URLs in background tabs. Fire-and-forget: all creates are
// issued in parallel without awaiting. Tabs appear as fast as Chrome can
// spawn them, which is typically <50ms for the whole batch.
function openUrls(urls){
  for(const u of urls){
    chrome.tabs.create({ url: u, active: false }).catch(()=>{});
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Primary path: content script asks us to extract media for a tweet ID.
  if(msg.action === 'extractMedia' && msg.id){
    if(!shouldProcess(msg.id)){
      // Already handled recently. Tell the content script "success but
      // deduped" so it neither closes the tab nor runs fallback.
      sendResponse({ success: true, deduped: true });
      return false;
    }
    extractMediaUrls(msg.id)
      .then(urls => {
        if(urls && urls.length){
          // Fire all tab creates in parallel (no await).
          openUrls(urls);
          // Respond immediately so the content script knows it succeeded
          // and does not run the DOM image fallback.
          sendResponse({ success: true });
          // Close the sender tab directly from the background — no message
          // round-trip back to the content script. Slight delay so the
          // sendResponse above has time to be delivered before the tab
          // (and its content script) is torn down.
          if(sender.tab && sender.tab.id){
            setTimeout(() => {
              chrome.tabs.remove(sender.tab.id).catch(()=>{});
            }, CLOSE_DELAY_MS);
          }
        }else{
          sendResponse({ success: false });
        }
      })
      .catch(() => sendResponse({ success: false }));
    return true; // keep the message channel open for async sendResponse
  }

  // Fallback path: content script collected image URLs from the DOM
  // (syndication API failed) and asks us to open them.
  if(msg.action === 'openUrls' && Array.isArray(msg.urls)){
    openUrls(msg.urls);
    if(sender.tab && sender.tab.id){
      setTimeout(() => {
        chrome.tabs.remove(sender.tab.id).catch(()=>{});
      }, CLOSE_DELAY_MS);
    }
    return false;
  }
});
})();
