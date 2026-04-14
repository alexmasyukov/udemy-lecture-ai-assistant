// Service worker: per-tab side panel wiring only.
//
// Settings live in chrome.storage.local and are read/written directly
// from the side panel (same extension origin, no need to round-trip
// through a messaging layer). LLM requests stream straight from the
// side panel — the service worker is not involved.

const UDEMY_LECTURE = /udemy\.com\/course\/.*\/learn\/lecture\//;

// Per-tab side panel: no default_path in manifest, no auto-open.
// Chrome automatically hides the panel when switching tabs and
// restores it (with preserved DOM state) when the user comes back.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: false })
  .catch(() => {});

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id || !UDEMY_LECTURE.test(tab.url || '')) return;
  // Must be synchronous — sidePanel.open() requires a user gesture,
  // and any `await` before it loses the gesture context.
  chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: 'sidepanel.html',
    enabled: true,
  });
  chrome.sidePanel.open({ tabId: tab.id });
});
