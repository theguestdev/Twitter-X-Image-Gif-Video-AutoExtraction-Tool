// Twitter/X Media -> Original
// Background service worker.
//
// Sole authority for media URL extraction. Fetches tweet metadata from the
// public syndication API (cdn.syndication.twimg.com) and downloads
// original-quality media (images AND videos) directly via
// chrome.downloads.download.
//
// Pipeline (v2.3):
//   - Images (pbs.twimg.com/media/*):
//     A background tab is opened so the user sees something happen, then
//     chrome.downloads.download is fired with the same URL the moment the
//     tab finishes loading. The tab is closed as soon as the downloadId is
//     received. (Same as v2.1 — kept because it gives visible feedback and
//     leaves the image tab open as a manual fallback if the download fails.)
//   - Videos / GIFs (video.twimg.com *.mp4):
//     Downloaded DIRECTLY via chrome.downloads.download — no tab is opened.
//     This is the v2.2 fix for the "large videos don't download" bug.
//     Previous behavior opened a tab and relied on Chrome's inline media
//     player to render the video so the user could right-click → Save As.
//     This broke for three independent reasons:
//       1. As of Dec 2025, Twitter's video CDN returns 403 for any URL
//          that still carries the `?tag=<n>` query parameter (cobalt #1486).
//       2. As of Dec 2025, Twitter's video CDN returns 403 when the request
//          includes a cross-origin Referer header (react-tweet #212).
//       3. Chrome's media player fails to load very large MP4 streams
//          from CDNs that use signed/range-requested URLs, so the tab
//          never reaches "complete" and the user perceives it as
//          "not even activating".
//     Direct chrome.downloads.download() fixes ALL three:
//       - We strip `?tag=` before download (fixes #1).
//       - chrome.downloads.download sends NO Referer by default (fixes #2).
//       - Downloads stream to disk via Chrome's download manager, never
//         touching the media player (fixes #3).
//
// Conversation-root walking (v2.3, the "image from comments instead of
// the video post" bug):
//   When the user opens a video tweet on x.com and scrolls/clicks into a
//   reply that has its own image, X's SPA updates the URL bar to the reply's
//   tweet ID. The content script fires `extractMedia` for that reply ID,
//   correctly fetches the reply's image, and downloads it — but the user
//   perceives it as "grabbing the comment's image instead of the video."
//   Fix: if the fetched tweet is a reply whose own media has NO video, we
//   re-fetch the parent (via in_reply_to_status_id_str) and prefer the
//   parent's video if it has one. Capped at ONE level — we don't chase
//   reply chains.
//
// Also fixes two latent v2.2 dead-code branches:
//   - Removed `data.media.all` fallback — that field is from the FxTwitter
//     API, NOT syndication. Never present on syndication responses.
//   - Renamed `data.quotedStatus` → `data.quoted_tweet`. The v2.2 code read
//     the GraphQL field name; syndication uses snake_case. Quote-tweet
//     media extraction was silently broken.
//
// Performance design:
//   - Tab creation / download calls are fire-and-forget (all in parallel).
//   - The sender tab is closed directly from here (no message round-trip
//     back to the content script).
//   - HTTP cache is allowed (syndication responses are stable).
//   - Response is sent immediately after firing tab creation / downloads;
//     the close happens a moment later so the response has time to land.
(function(){
'use strict';

// ============================================================
// ON/OFF GATE — single source of truth
// ============================================================
//
// All extension behavior is gated on `chrome.storage.local.enabled`.
// When `enabled === false`:
//   - The message handler returns `{ success: false, disabled: true }`
//     immediately and does NOT fetch syndication, does NOT open tabs,
//     does NOT close the sender tab. (No phantom operations.)
//   - The service worker stays alive only long enough to refuse the
//     message, then goes idle.
//
// The flag is read on every message receipt (never cached in a
// variable) so a popup toggle takes effect on the very next request,
// even mid-flight. chrome.storage reads are sync-fast from the SW's
// perspective because the SW owns the storage.
//
// Default on install: enabled = true (matches original v1.7 behavior).
//
// NOTE: the toolbar icon is a single black-and-white design and does
// NOT change between on/off states (per user request — less
// distracting). State is visible only by opening the popup.

const STORAGE_KEY = 'enabled';
const DEFAULT_ENABLED = true;

// Read the current enabled flag from storage. Always returns a fresh
// read — never cached. Resolves to a boolean.
function isEnabled(){
  return new Promise((resolve) => {
    try{
      chrome.storage.local.get([STORAGE_KEY], (res) => {
        const v = res && typeof res[STORAGE_KEY] === 'boolean'
          ? res[STORAGE_KEY]
          : DEFAULT_ENABLED;
        resolve(v);
      });
    }catch(e){
      // Storage unavailable — fail open (default-on) to preserve
      // original v1.7 behavior. Defensive against test/mocked envs.
      resolve(DEFAULT_ENABLED);
    }
  });
}

// ============================================================
// Original media extraction logic (v1.7, unchanged)
// ============================================================

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

// ============================================================
// v3.0: Bulletproof download queue
// ============================================================
//
// The previous fire-and-forget chrome.downloads.download() calls had four
// silent-failure modes that caused media to be dropped:
//
//   1. If the download initiation failed (network blip, malformed URL),
//      the callback ran with lastError set but nobody retried.
//   2. If a download was interrupted mid-stream (network drop, CDN 5xx),
//      Chrome surfaced it as a failed download on the shelf — but the
//      extension never knew and never retried.
//   3. If the service worker was terminated (30s of inactivity) when an
//      onChanged event fired, the event was silently dropped.
//   4. Starting 50 simultaneous downloads (e.g. user opened many tweets)
//      overwhelmed the CDN and the per-host connection pool, causing
//      timeouts that were also silently dropped.
//
// This module implements a guarantee that EVERY queued media URL eventually
// completes (or surfaces a terminal error to the user). Architecture:
//
//   - chrome.storage.local['dlQueue'] is the source of truth.
//     Survives SW termination AND browser close.
//   - Worker pool, N=5 concurrent downloads (avoids CDN 429s).
//   - onChanged listener catches completion/interruption in real time.
//   - chrome.alarms 'dlReconcile' fires every 30s → calls reconcile()
//     which uses chrome.downloads.search() to find anything onChanged
//     missed while the SW was dead. This is the safety net.
//   - Two-tier retry on interruption:
//       Tier 1: chrome.downloads.resume() — in-place, free, server-dependent.
//       Tier 2: fresh chrome.downloads.download() with backoff.
//   - Transient errors (NETWORK_*, SERVER_FAILED, CRASH, USER_SHUTDOWN)
//     retry indefinitely with escalating backoff (user said "no matter
//     the time"). Terminal errors (USER_CANCELED, FILE_NO_SPACE,
//     SERVER_FORBIDDEN, FILE_*) are surfaced via chrome.notifications
//     and not auto-retried (USER_CANCELED respects user intent; the
//     others require user action).
//   - On retry attempt 2+, conflictAction switches to 'overwrite' so
//     partial files are replaced rather than duplicating as '(1)'.
//
// The queue is keyed by a stable itemId (URL-derived), NOT by Chrome's
// downloadId (which changes on every retry).

const DL_QUEUE_KEY = 'dlQueue';
const DL_ALARM_NAME = 'dlReconcile';
const DL_ALARM_PERIOD_MIN = 0.5;          // 30 seconds (Chrome's min alarm period is 30s for released exts; 0.5 works in dev)
const DL_MAX_CONCURRENT = 5;
const DL_MAX_RESUME_ATTEMPTS = 5;         // tier-1 cap
const DL_MAX_REDOWNLOAD_ATTEMPTS = 1e9;   // tier-2: infinite (user wants "no matter the time")
const DL_BACKOFF_BASE_MS = 2000;
const DL_BACKOFF_MAX_MS = 5 * 60 * 1000;  // cap at 5 minutes between retries
const DL_BACKOFF_JITTER_MS = 1000;

// Transient errors: retry indefinitely. Terminal errors: stop + notify.
// Source: chrome.downloads InterruptReason enum.
const TRANSIENT_ERRORS = new Set([
  'NETWORK_FAILED', 'NETWORK_TIMEOUT', 'NETWORK_DISCONNECTED',
  'NETWORK_SERVER_DOWN', 'NETWORK_INVALID_REQUEST',
  'SERVER_FAILED', 'SERVER_UNREACHABLE', 'SERVER_CONTENT_LENGTH_MISMATCH',
  'FILE_TRANSIENT_ERROR', 'CRASH', 'USER_SHUTDOWN'
]);
const TERMINAL_ERRORS = new Set([
  'USER_CANCELED', 'SERVER_BAD_CONTENT', 'SERVER_UNAUTHORIZED',
  'SERVER_CERT_PROBLEM', 'SERVER_FORBIDDEN', 'SERVER_CROSS_ORIGIN_REDIRECT',
  'FILE_NO_SPACE', 'FILE_ACCESS_DENIED', 'FILE_NAME_TOO_LONG',
  'FILE_TOO_LARGE', 'FILE_BLOCKED', 'FILE_SECURITY_CHECK_FAILED',
  'FILE_VIRUS_INFECTED', 'FILE_HASH_MISMATCH', 'FILE_TOO_SHORT',
  'FILE_SAME_AS_SOURCE', 'FILE_FAILED'
]);

// ---- Queue state (in-memory mirror of chrome.storage.local) ----
let dlQueue = new Map();          // itemId → QueueItem
let activeDownloads = new Map();  // downloadId → itemId (for onChanged routing)
let reconcileRunning = false;

// QueueItem shape (in-memory + persisted):
//   { itemId, url, filename, kind, state, downloadId, attempt, resumeAttempts,
//     lastError, nextRetryAt, bytesReceived, totalBytes, addedAt, completedAt }
// state: 'pending' | 'in_progress' | 'complete' | 'failed_terminal' | 'user_canceled'

// Generate a stable itemId from URL. The same URL always maps to the same
// itemId, so re-enqueuing a URL is a no-op (dedupe).
function makeItemId(url){
  // Cheap stable hash: we don't need cryptographic strength, just uniqueness.
  // Strip query params (which we control via cleanVideoUrl/origImage) so
  // ?format=jpg&name=orig URLs and bare URLs dedupe together.
  let base = url;
  try{
    const u = new URL(url);
    base = u.origin + u.pathname;
  }catch(_){ /* malformed — use as-is */ }
  // Simple FNV-1a hash, 32-bit, hex-encoded.
  let h = 0x811c9dc5;
  for(let i = 0; i < base.length; i++){
    h ^= base.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

// Load the queue from storage on SW wake. Also called by reconcile().
// MERGES storage items into the in-memory map — does NOT replace the map
// entirely. This avoids race conditions where the SW started a download
// (state=in_progress in memory) but storage still has it as pending
// because the save is in flight.
async function dlLoadQueue(){
  try{
    const res = await chrome.storage.local.get([DL_QUEUE_KEY]);
    const arr = (res && res[DL_QUEUE_KEY]) || [];
    for(const item of arr){
      if(!item || !item.itemId) continue;
      // Skip items that are already complete/failed/canceled — they're history.
      if(item.state === 'complete' || item.state === 'failed_terminal' || item.state === 'user_canceled'){
        // But only skip if the in-memory item is ALSO complete/failed/canceled
        // (in case the in-memory state is newer).
        const existing = dlQueue.get(item.itemId);
        if(!existing || existing.state === item.state){
          dlQueue.delete(item.itemId);
        }
        continue;
      }
      // If we already have this item in memory, prefer the in-memory version
      // (it may have newer state, e.g. in_progress after dlStartDownload
      // updated synchronously before the next dlSaveQueue call completed).
      if(!dlQueue.has(item.itemId)){
        dlQueue.set(item.itemId, item);
      }
    }
  }catch(_){
    // Storage read failed — keep whatever we have in memory.
  }
}

// Persist the queue to storage. Best-effort — if storage is full we drop
// terminal/completed items to make room, then retry.
async function dlSaveQueue(){
  try{
    const arr = Array.from(dlQueue.values());
    await chrome.storage.local.set({ [DL_QUEUE_KEY]: arr });
  }catch(e){
    // Storage full — drop completed/failed items (they're just history)
    // and try once more.
    const pruned = Array.from(dlQueue.values()).filter(
      it => it.state !== 'complete' && it.state !== 'failed_terminal' && it.state !== 'user_canceled'
    );
    try{
      await chrome.storage.local.set({ [DL_QUEUE_KEY]: pruned });
    }catch(_){ /* give up — storage is genuinely unavailable */ }
  }
}

// Enqueue a URL for download. Idempotent — if the URL is already queued
// or in-flight, this is a no-op. Returns immediately; the worker pool
// picks up the item asynchronously.
async function dlEnqueue(url, filename, kind){
  if(!url) return;
  const itemId = makeItemId(url);
  if(dlQueue.has(itemId)){
    // Already queued or in-flight. Don't duplicate.
    return;
  }
  const item = {
    itemId,
    url,
    filename: filename || (kind === 'video' ? 'twitter_video.mp4' : 'twitter_image.jpg'),
    kind: kind || (isVideoMediaUrl(url) ? 'video' : 'image'),
    state: 'pending',
    attempt: 0,
    resumeAttempts: 0,
    lastError: null,
    nextRetryAt: 0,
    bytesReceived: 0,
    totalBytes: 0,
    addedAt: Date.now(),
    completedAt: null
  };
  dlQueue.set(itemId, item);
  await dlSaveQueue();
  dlPump(); // wake workers (no await — pump is fire-and-forget)
}

// Pump the worker pool: start as many pending downloads as concurrency allows.
// Idempotent — safe to call repeatedly.
function dlPump(){
  const inFlight = Array.from(dlQueue.values()).filter(
    it => it.state === 'in_progress'
  ).length;
  let slots = DL_MAX_CONCURRENT - inFlight;
  if(slots <= 0) return;

  for(const item of dlQueue.values()){
    if(slots <= 0) break;
    if(item.state !== 'pending') continue;
    // Honor backoff: if nextRetryAt is in the future, skip.
    if(item.nextRetryAt && Date.now() < item.nextRetryAt) continue;
    dlStartDownload(item);
    slots--;
  }
}

// Start (or restart) a download for an item. Calls chrome.downloads.download
// and wires up the downloadId → itemId mapping for onChanged routing.
function dlStartDownload(item){
  item.attempt++;
  item.resumeAttempts = 0;
  item.state = 'in_progress';
  item.lastError = null;
  item.nextRetryAt = 0;
  item.downloadId = null; // cleared until callback assigns new id
  // On retry attempt 2+, use 'overwrite' so partial files are replaced
  // rather than spawning '(1)', '(2)' duplicates.
  const conflictAction = item.attempt === 1 ? 'uniquify' : 'overwrite';

  // Persist state BEFORE calling chrome.downloads.download, so the
  // in_progress transition is durable even if the SW dies before the
  // download callback fires.
  dlSaveQueue();

  chrome.downloads.download({
    url: item.url,
    filename: item.filename,
    conflictAction,
    saveAs: false
  }, (downloadId) => {
    if(chrome.runtime.lastError || typeof downloadId !== 'number'){
      // Download initiation failed. Schedule a retry with backoff.
      // lastError is a chrome.runtime.LastError, not an InterruptReason —
      // but we treat initiation failures as transient (they're usually
      // "user is offline" or "download shelf closed").
      item.lastError = chrome.runtime.lastError ? chrome.runtime.lastError.message : 'initiation_failed';
      item.state = 'pending';
      item.nextRetryAt = Date.now() + dlBackoff(item.attempt);
      dlSaveQueue();
      return;
    }
    item.downloadId = downloadId;
    activeDownloads.set(downloadId, item.itemId);
    dlSaveQueue();
  });
}

// Compute backoff delay for a given attempt count.
// Exponential with cap + jitter. Never returns 0.
function dlBackoff(attempt){
  const exp = DL_BACKOFF_BASE_MS * Math.pow(2, Math.min(attempt - 1, 10));
  const capped = Math.min(exp, DL_BACKOFF_MAX_MS);
  const jitter = Math.floor(Math.random() * DL_BACKOFF_JITTER_MS);
  return capped + jitter;
}

// Classify an InterruptReason and decide the action.
// Returns: 'resume' | 'retry' | 'terminal' | 'user_canceled'
function dlClassifyError(errorReason){
  if(!errorReason) return 'retry'; // unknown — give it the benefit of the doubt
  if(errorReason === 'USER_CANCELED') return 'user_canceled';
  if(TRANSIENT_ERRORS.has(errorReason)) return 'retry';
  if(TERMINAL_ERRORS.has(errorReason)) return 'terminal';
  // Unknown error — default to retry (safer for "download everything").
  return 'retry';
}

// Handle an interrupt for an item. Decides resume vs. retry vs. terminal.
async function dlHandleInterrupt(item){
  if(!item.downloadId){
    // No downloadId means the download never started. Treat as retry.
    item.state = 'pending';
    item.nextRetryAt = Date.now() + dlBackoff(item.attempt);
    return;
  }
  // Fetch fresh state from Chrome — we need canResume + error details.
  let chromeItem = null;
  try{
    const results = await chrome.downloads.search({ id: item.downloadId });
    if(results && results.length) chromeItem = results[0];
  }catch(_){ /* search failed — fall through with stale info */ }

  const error = chromeItem ? chromeItem.error : item.lastError;
  const canResume = chromeItem ? chromeItem.canResume : false;
  item.lastError = error || item.lastError;

  const action = dlClassifyError(error);

  if(action === 'user_canceled'){
    item.state = 'user_canceled';
    activeDownloads.delete(item.downloadId);
    return;
  }
  if(action === 'terminal'){
    item.state = 'failed_terminal';
    activeDownloads.delete(item.downloadId);
    // Surface to user — they need to know this URL is permanently gone.
    dlNotifyTerminal(item, error);
    return;
  }
  // action === 'retry' — transient error.
  // Tier 1: try resume() if Chrome says we can.
  if(canResume && item.resumeAttempts < DL_MAX_RESUME_ATTEMPTS){
    try{
      await chrome.downloads.resume(item.downloadId);
      item.resumeAttempts++;
      item.state = 'in_progress'; // it should resume in-place
      return;
    }catch(_){
      // resume() failed — fall through to tier 2.
    }
  }
  // Tier 2: fresh download() with backoff.
  // Cap resumeAttempts so we don't loop resume() forever.
  item.state = 'pending';
  item.nextRetryAt = Date.now() + dlBackoff(item.attempt);
  activeDownloads.delete(item.downloadId);
  item.downloadId = null;
}

// Surface a terminal error to the user via chrome.notifications.
// Only fires if the notifications permission is granted; otherwise silent.
function dlNotifyTerminal(item, error){
  // We don't currently request 'notifications' permission in manifest.
  // If we add it later, this will start working. For now, log to console
  // so the failure is at least visible to anyone debugging.
  try{
    if(chrome.notifications && chrome.notifications.create){
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon-128.png',
        title: 'Download failed permanently',
        message: `Could not download ${item.filename}: ${error || 'unknown error'}`
      });
    }
  }catch(_){ /* notifications API not available */ }
  console.warn('[dlQueue] Terminal failure for', item.filename, '—', error);
}

// onChanged listener — fires on download state transitions.
// CRITICAL: this is silently dropped while the SW is dead. The reconcile
// alarm (below) is the safety net that catches anything this misses.
chrome.downloads.onChanged.addListener((delta) => {
  if(!('state' in delta) && !('error' in delta) && !('paused' in delta)) return;

  const itemId = activeDownloads.get(delta.id);
  if(!itemId){
    // Not our download — could be a user-initiated download from elsewhere.
    // Ignore it.
    return;
  }
  const item = dlQueue.get(itemId);
  if(!item) return;

  // Handle completion.
  if(delta.state && delta.state.current === 'complete'){
    item.state = 'complete';
    item.completedAt = Date.now();
    activeDownloads.delete(delta.id);
    dlSaveQueue();
    dlPump(); // start next pending download if any
    return;
  }

  // Handle interrupt.
  if(delta.state && delta.state.current === 'interrupted'){
    dlHandleInterrupt(item).then(() => {
      dlSaveQueue();
      dlPump();
    });
    return;
  }

  // Handle error (sometimes fires before state transition).
  if(delta.error && delta.error.current){
    dlHandleInterrupt(item).then(() => {
      dlSaveQueue();
      dlPump();
    });
    return;
  }

  // Handle user pause — respect it (don't auto-unpause).
  if(delta.paused && delta.paused.current === true){
    // User paused via the download shelf. Leave it alone.
    return;
  }
});

// Reconcile: the safety net. Called on SW wake AND every 30s via chrome.alarms.
// Catches anything onChanged missed while the SW was dead.
async function dlReconcile(){
  if(reconcileRunning) return;
  reconcileRunning = true;
  try{
    // Make sure we have the latest queue from storage (in case SW just woke).
    await dlLoadQueue();

    // Find all in-progress and interrupted downloads from Chrome's perspective.
    const [inProgress, interrupted] = await Promise.all([
      chrome.downloads.search({ state: 'in_progress' }),
      chrome.downloads.search({ state: 'interrupted' })
    ]);

    // 1. For each queue item marked in_progress, reconcile with Chrome's view.
    for(const item of dlQueue.values()){
      if(item.state !== 'in_progress' && item.state !== 'pending') continue;

      if(item.state === 'in_progress' && item.downloadId){
        // Find this downloadId in Chrome's view.
        const chromeMatch = inProgress.find(d => d.id === item.downloadId)
          || interrupted.find(d => d.id === item.downloadId);
        if(!chromeMatch){
          // Chrome has no record of this download. It completed (and was
          // erased from history) OR the browser was closed and the .crdownload
          // file was deleted. Treat as needing re-download.
          item.state = 'pending';
          item.downloadId = null;
          item.nextRetryAt = 0;
          activeDownloads.delete(item.downloadId);
        }else if(chromeMatch.state === 'complete'){
          // We missed the completion event — mark it done.
          item.state = 'complete';
          item.completedAt = Date.now();
          activeDownloads.delete(item.downloadId);
        }else if(chromeMatch.state === 'interrupted'){
          await dlHandleInterrupt(item);
        }
        // else: still in_progress in Chrome — leave it alone, it's working.
      }else if(item.state === 'pending'){
        // Honor backoff timing.
        if(item.nextRetryAt && Date.now() < item.nextRetryAt) continue;
      }
    }

    // 2. Orphan recovery: any interrupted download in Chrome that was started
    // by US (byExtensionId === our extension ID) but isn't in our queue —
    // likely from a previous SW lifetime that died mid-download. Try to
    // match by URL+filename; if no match, cancel it to avoid orphans piling up.
    const myExtId = chrome.runtime.id;
    for(const d of interrupted){
      if(d.byExtensionId !== myExtId) continue;
      // Is this downloadId tracked in our activeDownloads map?
      if(activeDownloads.has(d.id)) continue;
      // Try to find a queue item with the same URL.
      const matchingItem = Array.from(dlQueue.values()).find(
        it => it.url === d.url || it.url === d.finalUrl
      );
      if(matchingItem && !matchingItem.downloadId){
        // Adopt it — wire up the routing so future onChanged events route here.
        matchingItem.downloadId = d.id;
        matchingItem.state = 'in_progress';
        activeDownloads.set(d.id, matchingItem.itemId);
        // Then handle the interrupt (resume or retry).
        await dlHandleInterrupt(matchingItem);
      }
      // Else: leave it alone — it might belong to another part of the
      // extension that we don't track (currently none, but defensive).
    }

    await dlSaveQueue();
    dlPump();
  }finally{
    reconcileRunning = false;
  }
}

// Register the reconcile alarm + listener. Must be top-level so it survives
// SW restarts — alarms persist across SW terminations.
try{
  chrome.alarms.create(DL_ALARM_NAME, { periodInMinutes: DL_ALARM_PERIOD_MIN });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if(alarm.name === DL_ALARM_NAME){
      dlReconcile();
    }
  });
}catch(_){
  // alarms API not available — the extension will still work, but
  // reconcile only fires on SW wake (less robust).
}

// Fire-and-forget initial reconcile on SW startup. This catches any
// downloads that completed/interrupted while the SW was dead.
dlReconcile();


// ============================================================
// v2.5: FxTwitter fallback for NSFW / tombstoned tweets
// ============================================================
//
// As of 2025+, Twitter's syndication endpoint returns
// `{__typename:"TweetTombstone", tombstone:{}}` for NSFW/adult-content
// tweets. The user's logged-in browser can still view these tweets, but
// the extension cannot extract video URLs from the syndication response
// because the response is empty. The DOM image fallback in content.js is
// image-only by design (video elements on modern X are HLS .m3u8 streams
// that can't be downloaded as .mp4), so NSFW videos were never downloaded.
//
// FxTwitter (api.fxtwitter.com) is a third-party, community-run service
// that bypasses Twitter's NSFW tombstone by routing requests through
// authenticated maintainer-side accounts. It is anonymous from the
// caller's perspective — NO user auth or cookies are sent to FxTwitter.
// Returns the same `video.twimg.com/.../<hash>.mp4?tag=<n>` URL pattern
// as syndication, which our existing cleanVideoUrl() handles correctly.
//
// vxtwitter (api.vxtwitter.com) is an independent secondary fallback
// used if FxTwitter itself is down (its 30-day uptime is ~83.7%). The
// maintainer of vxtwitter explicitly states: "I do not monitor any
// tweets processed by this server" — privacy-equivalent to FxTwitter.
//
// Privacy guarantees:
//   - We never send the user's Twitter auth (auth_token / ct0 cookies)
//     to FxTwitter or vxtwitter. Only the tweet ID is sent (in the URL
//     path, as designed by these APIs).
//   - host_permissions for these APIs are added to manifest.json so the
//     user sees the dependency at install time (transparency).
//
// Caching:
//   Results (positive AND negative) are cached in chrome.storage.local
//   for 1 hour under key `fxtwitter:<tweet_id>`. Tweet media URLs are
//   immutable per tweet ID, so a longer TTL would be safe — but 1 hour
//   balances freshness against repeat-fetches for the same tweet in a
//   session. Negative results (FxTwitter also failed) are cached for
//   10 minutes to avoid hammering the service on a persistent failure.
const FXTWITTER_API = 'https://api.fxtwitter.com/status/';
const VXTWITTER_API = 'https://api.vxtwitter.com/Twitter/status/'; // handle is ignored by the service
const FXTWITTER_CACHE_TTL_MS = 60 * 60 * 1000;       // 1 hour for positive hits
const FXTWITTER_NEG_CACHE_TTL_MS = 10 * 60 * 1000;   // 10 min for negative hits
const FXTWITTER_FETCH_TIMEOUT_MS = 8000;              // 8s timeout (worker can be slow)

// Simple timeout wrapper for fetch — Chrome MV3 service workers don't have
// AbortSignal.timeout universally yet, so we race fetch against a timer.
function fetchWithTimeout(url, opts = {}, timeoutMs = FXTWITTER_FETCH_TIMEOUT_MS){
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('fetch timeout after ' + timeoutMs + 'ms: ' + url));
    }, timeoutMs);
    fetch(url, opts).then(
      (r) => { clearTimeout(timer); resolve(r); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

// Cache helpers. Async, swallow errors (cache is best-effort).
async function cacheGet(key){
  try{
    const res = await chrome.storage.local.get([key]);
    const v = res && res[key];
    if(!v || typeof v.ts !== 'number') return null;
    const ttl = v.found ? FXTWITTER_CACHE_TTL_MS : FXTWITTER_NEG_CACHE_TTL_MS;
    if(Date.now() - v.ts > ttl) return null;
    return v;
  }catch(_){ return null; }
}
async function cacheSet(key, value){
  try{
    await chrome.storage.local.set({ [key]: { ...value, ts: Date.now() } });
  }catch(_){ /* storage is best-effort */ }
}

// Convert FxTwitter's media response shape into our standard URL list.
// FxTwitter returns { tweet: { media: { all: [...], videos: [...], photos: [...] } } }.
// Each video object has `url` (highest-bitrate MP4) + `formats[]` (all variants).
// Each photo object has `url` (image URL).
// We normalize to the same URL list our syndication path produces, then
// pass through the existing origImage() / cleanVideoUrl() pipeline.
function collectFromFxMedia(tweet){
  if(!tweet || !tweet.media) return null;
  const urls = [];
  const all = tweet.media.all || [];
  for(const m of all){
    if(!m || !m.type) continue;
    if(m.type === 'video' || m.type === 'gif'){
      if(m.url){
        // FxTwitter returns the highest-bitrate MP4 in `url` directly.
        // Apply cleanVideoUrl to strip `?tag=` (same as syndication path).
        urls.push(cleanVideoUrl(m.url));
      }
    }else if(m.type === 'photo' || m.type === 'image'){
      if(m.url){
        // FxTwitter returns pbs.twimg.com URLs without `?format=&name=orig`,
        // so apply origImage() for the same quality normalization as syndication.
        const u = origImage(m.url);
        if(u) urls.push(u);
      }
    }
  }
  return urls.length ? urls : null;
}

// Fetch from FxTwitter, then vxtwitter as secondary fallback.
// Returns an array of media URLs (cleaned) or null if both fail.
// Caching: results are stored in chrome.storage.local keyed by tweet ID.
async function fetchViaFallbackServices(id){
  if(!id) return null;

  const cacheKey = 'fxtwitter:' + id;
  const cached = await cacheGet(cacheKey);
  if(cached){
    return cached.found ? cached.urls : null;
  }

  // --- Primary fallback: FxTwitter ---
  let urls = null;
  try{
    const r = await fetchWithTimeout(FXTWITTER_API + id, {
      headers: { 'Accept': 'application/json' }
    });
    if(r.ok){
      const data = await r.json();
      // FxTwitter returns {code, message, tweet} on v1.
      // tweet is null when the tweet doesn't exist or is private.
      if(data && data.tweet){
        urls = collectFromFxMedia(data.tweet);
      }
    }
  }catch(_){
    // Network error or timeout — fall through to vxtwitter.
  }

  // --- Secondary fallback: vxtwitter ---
  // Only try if FxTwitter returned nothing useful. vxtwitter is independent
  // software (different maintainer) and occasionally survives FxTwitter outages.
  if(!urls){
    try{
      const r = await fetchWithTimeout(VXTWITTER_API + id, {
        headers: { 'Accept': 'application/json' }
      });
      if(r.ok){
        const text = await r.text();
        // vxtwitter sometimes returns HTML on error pages; guard with a JSON parse.
        try{
          const data = JSON.parse(text);
          if(data && Array.isArray(data.mediaURLs)){
            // vxtwitter's mediaURLs is a flat array of CDN URLs (image and video mixed).
            // We need to distinguish videos from images to apply the right URL cleaning.
            // Heuristic: video.twimg.com = video, pbs.twimg.com = image.
            const out = [];
            for(const u of data.mediaURLs){
              if(typeof u !== 'string') continue;
              if(isVideoMediaUrl(u)){
                out.push(cleanVideoUrl(u));
              }else if(isImageMediaUrl(u)){
                const o = origImage(u);
                if(o) out.push(o);
              }
            }
            if(out.length) urls = out;
          }
        }catch(_){ /* not JSON — vxtwitter returned an error page */ }
      }
    }catch(_){
      // Both services failed — leave urls as null.
    }
  }

  // Cache both positive and negative results.
  await cacheSet(cacheKey, { found: !!urls, urls: urls || null });
  return urls;
}

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
//
// IMPORTANT (v2.2): The URL returned here is STRIPPED of the `?tag=<n>` query
// parameter via cleanVideoUrl(). As of December 2025, Twitter's video CDN
// (video.twimg.com) returns HTTP 403 for any URL that still carries `?tag=`
// (see cobalt issue #1486). The parameter used to be a harmless CDN routing
// hint — it is now an active blocker. Stripping it at the source (here)
// guarantees every downstream consumer (tab creation, direct download,
// DOM fallback) sees a clean URL.
function bestVideo(media){
  const variants = (media.video_info && media.video_info.variants) || [];
  const mp4s = variants.filter(v => v.url && v.content_type === 'video/mp4');
  if(!mp4s.length) return null;
  // Highest bitrate first; missing bitrate falls to the end of the list.
  mp4s.sort((a,b) => (b.bitrate||0) - (a.bitrate||0));
  return cleanVideoUrl(mp4s[0].url);
}

// Strip query parameters that Twitter's video CDN has started rejecting.
//
// As of Dec 2025, `video.twimg.com` returns 403 Forbidden for any URL that
// still carries the `?tag=<2-digit number>` query parameter (cobalt #1486).
// The `?tag=` value was historically a CDN routing hint and was ignored;
// it is now an active block. Removing it is mandatory for direct downloads.
//
// We also defensively drop a couple of legacy tracking params (`?origName`,
// `?size`) that some older syndication responses include — they don't trigger
// 403 today, but they serve no purpose for a direct download and could
// become blockable in the future.
function cleanVideoUrl(url){
  if(!url) return url;
  try{
    const u = new URL(url);
    u.searchParams.delete('tag');
    u.searchParams.delete('origName');
    u.searchParams.delete('size');
    return u.href;
  }catch(e){
    return url; // already invalid — let chrome.downloads surface the error
  }
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

// Inner worker. Returns the parsed syndication data for a single tweet ID,
// or null on fetch/parse failure. Pure fetch — does NOT walk the parent chain.
async function fetchTweetData(id){
  const url = SYNDICATION + id + '&token=' + SYNDICATION_TOKEN + '&lang=en';
  const r = await fetch(url, {
    headers: { 'Accept': 'application/json' }
  });
  if(!r.ok) return null;
  const data = await r.json();
  if(!data || !Object.keys(data).length) return null; // empty `{}` body
  // Tombstone (age-restricted / deleted / blocked tweet). The syndication
  // API returns `{__typename:"TweetTombstone", tombstone:{}}` for these —
  // we treat it as a failure so the content-script DOM image fallback runs.
  if(data.__typename === 'TweetTombstone') return null;
  return data;
}

// Collect every original-quality media URL from a parsed syndication tweet.
// Reads data.mediaDetails (this tweet), then falls back to data.parent
// (reply) and data.quoted_tweet (quote tweet) — each ONLY if this tweet
// had no media of its own.
//
// v2.3 corrected field names:
//   - Removed dead `data.media.all` branch — that field belongs to the
//     FxTwitter API, not syndication. It never existed on responses from
//     cdn.syndication.twimg.com and the v2.2 branch was dead code.
//   - Renamed `data.quotedStatus` → `data.quoted_tweet`. The old key was
//     the GraphQL/legacy field name; syndication uses snake_case. The
//     v2.2 branch never fired.
function collectMediaFromTweet(data){
  if(!data) return null;
  const urls = [];

  // 1. Direct media on this tweet.
  collectFromMedia(data.mediaDetails, urls);

  // 2. Reply tweet — media is on the parent (only if this tweet had none).
  if(!urls.length && data.parent){
    collectFromMedia(data.parent.mediaDetails, urls);
  }

  // 3. Quote tweet — media is on the quoted status (only if still none).
  if(!urls.length && data.quoted_tweet){
    collectFromMedia(data.quoted_tweet.mediaDetails, urls);
  }

  return urls.length ? urls : null;
}

// Fetch tweet metadata from the syndication API and return a list of
// original-quality media URLs (images and MP4s). Returns null if the API
// fails or the tweet has no extractable media.
//
// v2.3 conversation-root walking (the user's reported bug):
//   When the user opens a video tweet on x.com and scrolls/clicks into a
//   reply that has its own image, X's SPA updates the URL bar to the reply's
//   tweet ID. The content script fires `extractMedia` for that reply ID,
//   correctly fetches the reply's image, and downloads it — but the user
//   perceives this as "the extension grabbed the comment's image instead of
//   the video post."
//
//   The robust fix: if the fetched tweet is a reply (has
//   `in_reply_to_status_id_str`) AND the reply itself has NO video, walk
//   up to the parent and re-fetch. If the parent has a video, prefer the
//   parent's media. This matches user intent when the URL bar drifted to
//   a comment but the user opened the conversation to see the video.
//
//   We do NOT walk up when:
//   - This tweet already has a video (the user's intent is this tweet).
//   - This tweet has no in_reply_to_status_id_str (it's not a reply).
//   - The parent has no video (parent has only images or no media —
//     walking up would not improve the outcome and could surprise the
//     user by grabbing an unrelated ancestor's image).
//
//   We cap the walk at ONE level (direct parent only) by calling
//   fetchTweetData + collectMediaFromTweet directly. This prevents chasing
//   long reply chains, which could download media from an ancestor the
//   user never saw.
//
//   We re-fetch the parent via the same syndication endpoint rather than
//   trusting `data.parent.mediaDetails` because `data.parent` in
//   syndication responses is frequently incomplete (react-tweet's
//   TweetParent type does NOT include mediaDetails — only TweetBase
//   fields). The re-fetch gives us the parent's FULL media block.
async function extractMediaUrls(id){
  const data = await fetchTweetData(id);

  // v2.5: If syndication returns NOTHING (tombstone, deleted, NSFW-blocked),
  // try the FxTwitter + vxtwitter fallback cascade BEFORE giving up.
  // This is the only way to get media URLs for NSFW tweets — syndication
  // hard-tombstones them, and the DOM imageFallback in content.js cannot
  // extract video URLs (modern X serves HLS .m3u8 streams in <video>).
  if(!data){
    const fallbackUrls = await fetchViaFallbackServices(id);
    if(fallbackUrls && fallbackUrls.length) return fallbackUrls;
    return null;
  }

  const urls = collectMediaFromTweet(data);
  if(!urls || !urls.length){
    // Syndication returned a non-tombstone tweet but with no media we could
    // extract. Try the fallback services — sometimes syndication's mediaDetails
    // is empty for sensitive content even when the tweet itself loads.
    const fallbackUrls = await fetchViaFallbackServices(id);
    if(fallbackUrls && fallbackUrls.length) return fallbackUrls;
    return null;
  }

  // If this tweet's own media contained a video, return as-is — no walk.
  if(urls.some(u => isVideoMediaUrl(u))) return urls;

  // This tweet's media is image-only. If it's a reply AND the parent has
  // a video, prefer the parent's video (the user's likely intent).
  if(data.in_reply_to_status_id_str){
    try{
      const parentData = await fetchTweetData(data.in_reply_to_status_id_str);
      if(parentData){
        const parentUrls = collectMediaFromTweet(parentData);
        if(parentUrls && parentUrls.some(u => isVideoMediaUrl(u))){
          return parentUrls;
        }
      }else{
        // Parent itself is tombstoned (e.g. NSFW parent) — try fallback
        // services for the parent ID.
        const parentFallback = await fetchViaFallbackServices(data.in_reply_to_status_id_str);
        if(parentFallback && parentFallback.some(u => isVideoMediaUrl(u))){
          return parentFallback;
        }
      }
    }catch(_){
      // Parent fetch failed (deleted, rate-limited, etc.). Fall through
      // with whatever urls we already collected (the reply's own image).
    }
  }

  return urls;
}

// Open a list of media URLs. ALL downloads now route through the bulletproof
// download queue (dlEnqueue). The queue handles:
//   - Concurrency cap (5 concurrent downloads)
//   - Dedupe (same URL never queued twice)
//   - Retry on transient errors (NETWORK_*, SERVER_FAILED, etc.)
//   - Resume on interrupt (chrome.downloads.resume)
//   - Reconcile on SW restart (catches anything onChanged missed)
//   - Terminal error surfacing (USER_CANCELED, FILE_*, etc.)
//
// v3.0 change: previously, image URLs went through a tab→onUpdated→download
// pipeline because the old chrome.downloads.download was fire-and-forget and
// had no retry. The tab was a manual-save fallback when downloads failed.
// Now that the queue retries indefinitely and surfaces terminal errors,
// the tab fallback is unnecessary. Direct download via the queue is strictly
// better — no tab lifecycle to manage, no extra memory, no "phantom tab"
// risk if the SW dies mid-pipeline.
//
// For VIDEO URLs (video.twimg.com *.mp4): same path. The queue's
// chrome.downloads.download call sends no Referer by default (which Twitter's
// CDN now requires) and cleanVideoUrl() upstream already stripped ?tag=.
function openUrls(urls){
  for(const u of urls){
    if(isVideoMediaUrl(u)){
      const clean = cleanVideoUrl(u);
      const filename = deriveVideoFilename(clean);
      dlEnqueue(clean, filename, 'video');
      continue;
    }
    if(isImageMediaUrl(u)){
      const filename = deriveImageFilename(u);
      dlEnqueue(u, filename, 'image');
      continue;
    }
    // Unknown URL type — enqueue with default filename and let the queue try.
    dlEnqueue(u, null, null);
  }
}

// ============================================================
// Image-tab pipeline — REMOVED in v3.0
// ============================================================
// The previous imageTabs Map, chrome.tabs.onUpdated listener, and tab-→download
// →close dance are no longer needed. All media now goes through dlEnqueue,
// which uses chrome.downloads.download directly. The tab pipeline was the
// source of multiple silent-failure modes (tabs that never reached "complete"
// for slow-loading images, SW death losing the imageTabs map, etc.) and is
// replaced by the queue's retry+reconcile layer.
//
// The isImageMediaUrl() helper is kept because openUrls() uses it to route
// URLs. The imageTabs Map and onUpdated listener are removed below.

// Twitter image CDN: https://pbs.twimg.com/media/<id>.<ext>?format=...&name=orig
// We deliberately match only the /media/ path so we do NOT auto-download
// profile images (/profile_images/) or banners (/profile_banners/), which
// this extension does not currently open anyway.
function isImageMediaUrl(url){
  if(!url) return false;
  try{
    const u = new URL(url);
    return u.hostname === 'pbs.twimg.com' && u.pathname.startsWith('/media/');
  }catch(e){ return false; }
}

// Twitter video CDN: https://video.twimg.com/.../<hash>.mp4[?tag=...]
// Covers:
//   /ext_tw_video/<tweetId>/pu/vid/<w>x<h>/<hash>.mp4  (uploaded videos)
//   /ext_tw_video/<tweetId>/pu/pl/<hash>.mp4            (rare legacy)
//   /tweet_video/<hash>.mp4                            (animated GIFs)
//   /amplify_video/<tweetId>/vid/<w>x<h>/<hash>.mp4     (amplified/promoted)
// We match on hostname + .mp4 path suffix. HLS .m3u8 URLs are already
// filtered out by bestVideo() upstream, so they never reach here.
function isVideoMediaUrl(url){
  if(!url) return false;
  try{
    const u = new URL(url);
    return u.hostname === 'video.twimg.com'
      && /\.mp4$/i.test(u.pathname);
  }catch(e){ return false; }
}

// Derive a clean download filename from the URL.
//
// CRITICAL (v2.2): As of mid-2025, Twitter's syndication API increasingly
// returns `media_url_https` WITHOUT a path extension. The URL looks like:
//
//     https://pbs.twimg.com/media/GcNabcXYZ?format=jpg&name=orig
//
// instead of the historical:
//
//     https://pbs.twimg.com/media/GcNabcXYZ.jpg?name=orig
//
// The actual image format is conveyed ONLY via the `?format=` query
// parameter that we ourselves attach in origImage(). Chrome's
// chrome.downloads.download API does NOT inspect query parameters when
// determining the file extension — it only looks at the URL PATH.
//
// In v2.1, deriveImageFilename returned the bare ID ("GcNabcXYZ") for any
// extensionless URL, and chrome.downloads.download saved the file with NO
// extension at all. The user had to manually rename every such file to
// "GcNabcXYZ.jpg" to view it. This is the root cause of bug #2.
//
// v2.2 fix: if the path has no recognizable extension, append one derived
// from the `?format=` query parameter (falling back to `jpg` for safety).
// This is a ROOT-LEVEL fix — we construct the correct filename at the source
// rather than relying on Chrome's broken query-param inference.
//
// Examples (v2.2):
//   https://pbs.twimg.com/media/GcNabcXYZ.jpg?format=jpg&name=orig
//     → "GcNabcXYZ.jpg"  (extension already in path — unchanged)
//   https://pbs.twimg.com/media/GcNabcXYZ?format=jpg&name=orig
//     → "GcNabcXYZ.jpg"  (extension sourced from ?format= — NEW)
//   https://pbs.twimg.com/media/GcNabcXYZ?format=png&name=orig
//     → "GcNabcXYZ.png"  (extension sourced from ?format= — NEW)
//
// `conflictAction: 'uniquify'` (set at download time) handles the rare case
// where the same image is downloaded twice.
function deriveImageFilename(url){
  try{
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    if(!last){
      // No path segment at all (shouldn't happen for pbs.twimg.com/media/).
      // Fall back to the format query param, or 'jpg' as last resort.
      const fmt = (u.searchParams.get('format') || 'jpg').toLowerCase();
      return 'twitter_image.' + fmt;
    }
    // Strip any accidental query residue (defensive — pathname shouldn't
    // contain `?`, but if someone passes a malformed URL we don't want
    // a filename containing `?format=...`).
    const name = last.split('?')[0];
    // If the path already has a recognized image extension, use it as-is.
    // This preserves v2.1 behavior for the (still common) .jpg/.png/.webp
    // URLs and prevents double-extension bugs like "foo.jpg.jpg".
    if(/\.(jpe?g|png|webp|gif|bmp|svg|heic|heif|avif)$/i.test(name)){
      return name;
    }
    // No extension in path — derive from ?format= query param. This is the
    // v2.2 fix for the bug where extensionless Twitter image URLs were
    // saved as extension-less files.
    const fmt = (u.searchParams.get('format') || 'jpg').toLowerCase();
    return name + '.' + fmt;
  }catch(e){
    return 'twitter_image.jpg';
  }
}

// Derive a clean download filename for a video URL.
//
// Twitter video URLs take several shapes:
//   https://video.twimg.com/ext_tw_video/<tweetId>/pu/vid/<w>x<h>/<hash>.mp4?tag=12
//   https://video.twimg.com/tweet_video/<hash>.mp4           (animated GIF)
//   https://video.twimg.com/amplify_video/<tweetId>/vid/<w>x<h>/<hash>.mp4
//
// We always want the final filename to end in `.mp4`. cleanVideoUrl() has
// already stripped `?tag=` and other rejected query params upstream, so we
// only need to look at the path here.
//
// If the path's last segment already ends in `.mp4`, use it verbatim. This
// preserves Twitter's per-upload unique `<hash>.mp4` filename, which avoids
// collisions across tweets. If for some reason the path lacks `.mp4`
// (defensive — hasn't been observed in the wild but is possible for future
// URL shapes), we append it.
//
// `conflictAction: 'uniquify'` (set at download time) handles the rare case
// where the same video hash is downloaded twice.
function deriveVideoFilename(url){
  try{
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    if(!last){
      return 'twitter_video.mp4';
    }
    const name = last.split('?')[0];
    if(/\.mp4$/i.test(name)){
      return name;
    }
    // Path segment exists but lacks .mp4 — append it. This is the video
    // equivalent of the image extension fix above.
    return name + '.mp4';
  }catch(e){
    return 'twitter_video.mp4';
  }
}

// ============================================================
// Tab-pipeline listeners — REMOVED in v3.0
// ============================================================
// The chrome.tabs.onUpdated and chrome.tabs.onRemoved listeners that drove
// the image-tab → download → close pipeline are gone. All media downloads
// now route through dlEnqueue, which calls chrome.downloads.download directly.
// No tabs are opened for media URLs anymore.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ============================================================
  // ON/OFF GATE — checked FIRST on every message.
  // When OFF: refuse to extract media or open URLs. Do NOT close
  // the sender tab (the user wants to keep reading it). Do NOT
  // fetch the syndication API. (No phantom operations.)
  // ============================================================
  if(msg && (msg.action === 'extractMedia' || msg.action === 'openUrls')){
    isEnabled().then((enabled) => {
      if(!enabled){
        sendResponse({ success: false, disabled: true });
        return;
      }
      handleMediaMessage(msg, sender, sendResponse);
    });
    return true; // keep channel open for async sendResponse
  }

  // Unknown messages are ignored. The popup does NOT send messages — it
  // writes directly to chrome.storage.local, which the background reads
  // via isEnabled() on every message receipt.
});

// Actual media-handling logic, factored out so the gate stays clean.
//
// TAB CLOSE POLICY (v2.4 fix):
//   The sender tab is closed ONLY when the content script signals
//   `isInitial: true` — meaning the user did a full page-load navigation
//   to a tweet URL (e.g. clicked an external link, pasted a URL, or opened
//   a tweet in a new tab). In that case, the tweet tab is a "transit" tab
//   whose sole purpose was to deliver the media — closing it is the intended
//   workflow.
//
//   When `isInitial` is false (SPA navigation within x.com), the sender tab
//   is the user's main Twitter session tab. Closing it would destroy their
//   session. We do NOT close in that case.
//
//   The content script passes `isInitial` in the message body. The `openUrls`
//   fallback path (DOM imageFallback) also passes `isInitial` so the same
//   rule applies.
function handleMediaMessage(msg, sender, sendResponse){
  // Primary path: content script asks us to extract media for a tweet ID.
  if(msg.action === 'extractMedia' && msg.id){
    if(!shouldProcess(msg.id)){
      // Already handled recently. Tell the content script "success but
      // deduped" so it neither closes the tab nor runs fallback.
      sendResponse({ success: true, deduped: true });
      return;
    }
    extractMediaUrls(msg.id)
      .then(urls => {
        if(urls && urls.length){
          // Fire all tab creates in parallel (no await).
          openUrls(urls);
          // Respond immediately so the content script knows it succeeded
          // and does not run the DOM image fallback.
          sendResponse({ success: true });
          // Close the sender tab ONLY on initial page loads (not SPA nav).
          // See the TAB CLOSE POLICY comment above.
          if(msg.isInitial && sender.tab && sender.tab.id){
            setTimeout(() => {
              chrome.tabs.remove(sender.tab.id).catch(()=>{});
            }, CLOSE_DELAY_MS);
          }
        }else{
          sendResponse({ success: false });
        }
      })
      .catch(() => sendResponse({ success: false }));
    return;
  }

  // Fallback path: content script collected image URLs from the DOM
  // (syndication API failed) and asks us to open them.
  if(msg.action === 'openUrls' && Array.isArray(msg.urls)){
    openUrls(msg.urls);
    // Same close policy: only close on initial page load.
    if(msg.isInitial && sender.tab && sender.tab.id){
      setTimeout(() => {
        chrome.tabs.remove(sender.tab.id).catch(()=>{});
      }, CLOSE_DELAY_MS);
    }
    sendResponse({ success: true });
    return;
  }

  // Unknown action — respond false so the content script can fall back.
  sendResponse({ success: false });
}
})();
