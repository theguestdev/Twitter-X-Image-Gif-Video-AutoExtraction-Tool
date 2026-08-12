// Twitter/X SPA media opener.
//
// Delegates ALL media extraction to the background service worker, which uses
// the public syndication API (cdn.syndication.twimg.com) as the authoritative
// source for tweet media URLs.
//
// This content script handles:
//   1. Initial page load detection (full navigation to a tweet URL)
//   2. SPA navigation detection (pushState/replaceState/popstate hooks)
//   3. Image-only DOM fallback when the syndication API fails
//
// It NEVER extracts video/GIF URLs from the DOM. The syndication API is the
// only source for video URLs.
//
// Performance design:
//   - The background closes the tweet tab directly; no closeTab message
//     round-trip from here.
//   - On success, this script does nothing — the background handles tab
//     lifecycle. No setTimeout, no extra messages.
//   - Fallback only runs if the background reports failure.
(function(){
'use strict';

if(window.__twMediaOrig) return;
window.__twMediaOrig = true;

let lastPath = location.pathname;

// Extract the tweet ID from a URL path like /username/status/12345/photo/1.
// The numeric ID is always the segment immediately after /status/.
function idFromPath(p = location.pathname){
  const m = p.match(/\/status\/(\d+)/);
  return m && m[1];
}

// Rewrite a pbs.twimg.com image URL to its original-quality variant.
function imgOrig(s){
  try{
    const u = new URL(s);
    const ext = (u.pathname.match(/\.(\w+)$/)||[])[1] || 'jpg';
    u.searchParams.set('name', 'orig');
    u.searchParams.set('format', ext);
    return u.href;
  }catch(e){ return null; }
}

// Collect original-quality image URLs from <img> tags currently in the DOM.
// Only used as a fallback when the syndication API is unavailable.
function collectImageUrls(){
  const found = new Set();
  document.querySelectorAll('img[src*="pbs.twimg.com/media/"]').forEach(img => {
    const u = imgOrig(img.src);
    if(u) found.add(u);
  });
  return found.size ? [...found] : null;
}

// DOM-based image fallback. Only triggered when the syndication API fails.
// Watches the DOM as it hydrates and, as soon as at least one pbs.twimg.com
// image is present, sends the URLs to the background to be opened in
// background tabs. Gives up silently after 5 seconds if no images appear.
//
// IMPORTANT: this fallback is image-only. We deliberately do not attempt to
// extract video URLs from <video> or <source> elements — on modern X those
// are frequently placeholder/preview/HLS URLs and would yield wrong media.
function imageFallback(){
  if(!document.body){
    // body not ready yet (we run at document_start); retry on next frame.
    requestAnimationFrame(imageFallback);
    return;
  }

  let done = false;
  let obs = null;

  const finish = () => {
    if(done) return;
    done = true;
    if(obs) obs.disconnect();
    const urls = collectImageUrls();
    if(urls && urls.length){
      // Send URLs to the background for reliable tab creation
      // (window.open from content scripts can be blocked by popup blockers).
      try{
        chrome.runtime.sendMessage({ action: 'openUrls', urls });
      }catch(e){
        // Last-resort: window.open
        for(const u of urls){
          try{ window.open(u, '_blank'); }catch(_){}
        }
      }
    }
    // If no images found, leave the tweet tab open for the user.
  };

  // Watch for media nodes being inserted as the page hydrates.
  obs = new MutationObserver(() => { if(collectImageUrls()) finish(); });
  obs.observe(document.body, { childList: true, subtree: true });

  // Try immediately, after a short delay (in case hydration is fast), and
  // give up after 5 seconds.
  requestAnimationFrame(() => { if(collectImageUrls()) finish(); });
  setTimeout(() => { if(collectImageUrls()) finish(); }, 500);
  setTimeout(finish, 5000);
}

// Ask the background to extract and open media for the given tweet ID.
// `isInitial` distinguishes a full page load (where closing the tweet tab
// afterwards is the intended workflow) from an in-app SPA navigation (where
// closing the tab would destroy the user's Twitter session).
function handleTweet(id, isInitial){
  try{
    chrome.runtime.sendMessage(
      { action: 'extractMedia', id },
      (resp) => {
        if(chrome.runtime.lastError || !resp){
          // Background didn't respond (service worker restart, etc.) — fall back.
          imageFallback();
          return;
        }
        if(resp.deduped){
          // Recently processed by the background — leave the tab open, do nothing.
          return;
        }
        if(!resp.success){
          // Syndication API failed — try DOM image fallback.
          imageFallback();
          return;
        }
        // Success: the background has fired tab creation in parallel and
        // will close this tab directly. Nothing to do here.
      }
    );
  }catch(e){
    imageFallback();
  }
}

// Called from SPA navigation hooks. Skips if the path hasn't actually
// changed (Twitter's router sometimes calls replaceState with the same URL
// for analytics/scroll-tracking reasons).
function check(){
  if(location.pathname === lastPath) return;
  lastPath = location.pathname;
  const id = idFromPath();
  if(id) handleTweet(id, false); // SPA nav → never auto-close
}

// Hook SPA navigation. Twitter's router uses pushState/replaceState for
// in-app navigations, so we intercept those and treat them as new tweet
// views. popstate covers browser back/forward.
history.pushState = new Proxy(history.pushState, {
  apply(t, x, a){ const r = Reflect.apply(t, x, a); check(); return r; }
});
history.replaceState = new Proxy(history.replaceState, {
  apply(t, x, a){ const r = Reflect.apply(t, x, a); check(); return r; }
});
addEventListener('popstate', check);

// Initial page load — runs at document_start, so location is already the
// final tweet URL but the DOM may not be ready yet.
const initialId = idFromPath();
if(initialId) handleTweet(initialId, true);
})();
