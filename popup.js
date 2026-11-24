// Toolbar popup: one switch bound to the same storage key the overlay watches.
(function () {
  'use strict';
  const KEY = 'cuo_hidden';
  const box = document.getElementById('toggle');
  chrome.storage.local.get(KEY, (v) => {
    box.checked = !(v && v[KEY]);
  });
  box.addEventListener('change', () => {
    chrome.storage.local.set({ [KEY]: !box.checked });
  });
})();
