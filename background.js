// Service worker: opens the side panel on action click and proxies LLM
// requests so the side panel doesn't talk to localhost directly (cleaner CORS
// + future-proof if we add Anthropic/OpenAI cloud later).

const UDEMY_LECTURE = /udemy\.com\/course\/.*\/learn\/lecture\//;

// Per-tab side panel: no default_path in manifest, no auto-open.
// Chrome automatically hides the panel when switching tabs and restores
// it (with preserved DOM state) when the user comes back.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: false })
  .catch(() => {});

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id || !UDEMY_LECTURE.test(tab.url || '')) return;
  chrome.sidePanel.setOptions({
    tabId: tab.id,
    path: 'sidepanel.html',
    enabled: true,
  });
  chrome.sidePanel.open({ tabId: tab.id });
});

const DEFAULTS = {
  provider: 'local', // 'local' | 'openai'
  baseUrl: 'http://127.0.0.1:1234/v1',
  model: 'gemma-4-e4b-it',
  openaiApiKey: '',
  openaiModel: 'gpt-5.4-mini',
  temperature: 0.3,
  uiFontSize: 13,
  chatFontSize: 16,
  transparentAssistant: false,
};

async function getSettings() {
  const stored = await chrome.storage.local.get(['settings']);
  return { ...DEFAULTS, ...(stored.settings || {}) };
}

async function listModels() {
  const { baseUrl } = await getSettings();
  const r = await fetch(`${baseUrl}/models`);
  if (!r.ok) throw new Error(`models HTTP ${r.status}`);
  const j = await r.json();
  return (j.data || []).map((m) => m.id);
}

async function chatCompletion({ messages, model, temperature, signal }) {
  const settings = await getSettings();
  const r = await fetch(`${settings.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || settings.model,
      temperature: temperature ?? settings.temperature,
      messages,
      stream: false,
    }),
    signal,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`LLM HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
  const j = await r.json();
  return j.choices?.[0]?.message?.content ?? '';
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'LLM_CHAT') {
    chatCompletion(msg.payload)
      .then((content) => sendResponse({ ok: true, content }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg?.type === 'LLM_LIST_MODELS') {
    listModels()
      .then((models) => sendResponse({ ok: true, models }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg?.type === 'GET_SETTINGS') {
    getSettings().then((s) => sendResponse({ ok: true, settings: s }));
    return true;
  }
  if (msg?.type === 'SAVE_SETTINGS') {
    chrome.storage.local
      .set({ settings: { ...DEFAULTS, ...msg.settings } })
      .then(() => sendResponse({ ok: true }));
    return true;
  }
});
