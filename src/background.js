// Clicking the toolbar icon shows/hides the overlay on every open claude.ai tab.
// The content script listens for this storage key.
chrome.action.onClicked.addListener(async () => {
  const { cuo_hidden } = await chrome.storage.local.get('cuo_hidden');
  await chrome.storage.local.set({ cuo_hidden: !cuo_hidden });
});
