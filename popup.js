// popup.js
//
// UI controller for the toolbar popup. Single responsibility:
//   - read current `enabled` flag from chrome.storage.local
//   - render ON/OFF visual state into the toggle button
//   - on click, flip the flag and persist it
//
// This script does NOT do any media extraction, message routing, or
// tab manipulation. It only owns the toggle UX.

(function () {
  'use strict';

  const STORAGE_KEY = 'enabled';
  const DEFAULT_ENABLED = true; // first install: extension is ON

  const toggle = document.getElementById('toggle');

  // Render the toggle button to match `enabled`.
  function render(enabled) {
    toggle.classList.toggle('is-on', enabled);
    toggle.textContent = enabled ? 'ON' : 'OFF';
    toggle.setAttribute('aria-checked', enabled ? 'true' : 'false');
  }

  // Initialize the toggle from storage. If the key is missing (first install),
  // we set it to DEFAULT_ENABLED so the user is not confused by an unknown
  // state. The background also has its own default-on check at install time.
  function init() {
    chrome.storage.local.get([STORAGE_KEY], (res) => {
      const enabled =
        typeof res[STORAGE_KEY] === 'boolean'
          ? res[STORAGE_KEY]
          : DEFAULT_ENABLED;

      if (typeof res[STORAGE_KEY] !== 'boolean') {
        chrome.storage.local.set({ [STORAGE_KEY]: enabled });
      }
      render(enabled);
    });
  }

  // Click handler: flip the flag, persist, re-render.
  function onClick() {
    chrome.storage.local.get([STORAGE_KEY], (res) => {
      const current =
        typeof res[STORAGE_KEY] === 'boolean'
          ? res[STORAGE_KEY]
          : DEFAULT_ENABLED;
      const next = !current;
      chrome.storage.local.set({ [STORAGE_KEY]: next });
      render(next);
    });
  }

  toggle.addEventListener('click', onClick);

  // Live-update if storage changes from elsewhere (e.g. user reloaded the
  // extension, or another part of the code flipped the flag).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEY]) {
      render(changes[STORAGE_KEY].newValue === true);
    }
  });

  init();
})();
