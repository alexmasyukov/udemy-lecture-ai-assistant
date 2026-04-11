const $ = (sel) => document.querySelector(sel);

const els = {
  statusDot: $('#status-dot'),
  settingsToggle: $('#settings-toggle'),
  settingsPanel: $('#settings-panel'),
  baseUrl: $('#baseUrl'),
  model: $('#model'),
  reloadModels: $('#reload-models'),
  temperature: $('#temperature'),
  saveSettings: $('#save-settings'),
  loadTranscript: $('#load-transcript'),
  summarize: $('#summarize'),
  strictMode: $('#strict-mode'),
  messages: $('#messages'),
  askForm: $('#ask-form'),
  askInput: $('#ask-input'),
  askBtn: $('#ask-btn'),
};

const state = {
  transcript: null, // { source, text, timestampedText, cues }
  meta: null,
  history: [],
  settings: null,
};

// ----- helpers -----

function send(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (resp) => resolve(resp));
  });
}

async function getActiveUdemyTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/udemy\.com\/course\/.*\/learn\/lecture\//.test(tab.url)) {
    return null;
  }
  return tab;
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(e.message)) {
      throw e;
    }
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js'],
  });
  return chrome.tabs.sendMessage(tabId, message);
}

function setMsgContent(div, text) {
  if (div.classList.contains('assistant')) {
    div.innerHTML = window.renderMarkdown(text);
  } else {
    div.textContent = text;
  }
}

function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  setMsgContent(div, text);
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  return div;
}

function setStatus(kind) {
  els.statusDot.classList.remove('ok', 'err');
  if (kind) els.statusDot.classList.add(kind);
}

function setBusy(busy) {
  els.askInput.disabled = busy;
  els.askBtn.disabled = busy;
  els.summarize.disabled = busy || !state.transcript;
}

// ----- settings -----

async function loadSettings() {
  const resp = await send('GET_SETTINGS');
  state.settings = resp.settings;
  els.baseUrl.value = state.settings.baseUrl;
  els.temperature.value = state.settings.temperature;
  await refreshModels();
}

async function refreshModels() {
  els.model.innerHTML = '<option>loading…</option>';
  const resp = await send('LLM_LIST_MODELS');
  els.model.innerHTML = '';
  if (!resp.ok) {
    setStatus('err');
    const opt = document.createElement('option');
    opt.textContent = `error: ${resp.error}`;
    els.model.appendChild(opt);
    return;
  }
  setStatus('ok');
  for (const id of resp.models) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id;
    if (id === state.settings.model) opt.selected = true;
    els.model.appendChild(opt);
  }
}

async function saveSettings() {
  const next = {
    baseUrl: els.baseUrl.value.trim() || 'http://127.0.0.1:1234/v1',
    model: els.model.value,
    temperature: parseFloat(els.temperature.value) || 0.3,
  };
  await send('SAVE_SETTINGS', { settings: next });
  state.settings = next;
  addMsg('system', 'Settings saved');
}

// ----- transcript -----

async function loadTranscript() {
  const tab = await getActiveUdemyTab();
  if (!tab) {
    addMsg('error', 'Open a Udemy lecture page first.');
    return;
  }
  els.loadTranscript.disabled = true;
  state.transcript = null;
  state.meta = null;
  try {
    const resp = await sendToTab(tab.id, { type: 'GET_TRANSCRIPT' });
    if (!resp?.ok) throw new Error(resp?.error || 'no response from content script');
    state.transcript = resp.transcript;
    state.meta = resp.meta;
    const t = resp.transcript;
    const localeStr = t.captionLabel ? ` · ${t.captionLabel}` : '';
    const title = resp.meta.lectureTitle || 'Lecture';
    addMsg(
      'system',
      `${title} — ${t.source.toUpperCase()}${localeStr} · ${t.cues.length} cues · ${t.text.length.toLocaleString()} chars · lecture ${resp.meta.lectureId || '?'}`
    );
    setBusy(false);
  } catch (e) {
    addMsg('error', `Could not load transcript: ${e.message}`);
  } finally {
    els.loadTranscript.disabled = false;
  }
}

// ----- LLM -----

function systemPrompt() {
  const hasTranscript = Boolean(state.transcript);
  const hasTimestamps = state.transcript?.source === 'api';
  const strict = els.strictMode.classList.contains('active');
  const common = [
    'Ты — помощник-репетитор по лекциям Udemy.',
    'ВАЖНО: всегда отвечай ТОЛЬКО на русском языке.',
    'Отвечай кратко и по делу. Можешь использовать Markdown (заголовки, списки, **жирный**, `код`, блоки кода) для форматирования.',
  ];
  if (!hasTranscript) {
    return [
      ...common,
      'Транскрипт лекции не загружен. Отвечай как обычный эксперт по теме вопроса.',
    ].join('\n');
  }
  const modeLines = strict
    ? [
        'Строгий режим: используй ИСКЛЮЧИТЕЛЬНО текст транскрипта ниже как источник информации.',
        'Если в транскрипте нет ответа — честно скажи об этом и ничего не придумывай.',
      ]
    : [
        'Транскрипт лекции ниже — это основной контекст, но ты можешь свободно использовать свои общие знания, чтобы дополнить, объяснить или ответить на смежные вопросы.',
        'Если вопрос не про лекцию — отвечай как обычный эксперт. Если про лекцию — опирайся на транскрипт, но можешь расширять объяснения своим знанием.',
      ];
  return [
    ...common,
    hasTimestamps
      ? 'Каждая строка транскрипта начинается с [таймкода] — ссылайся на них, когда это уместно.'
      : '',
    ...modeLines,
    '',
    `Название лекции: ${state.meta?.lectureTitle || 'Неизвестно'}`,
    '',
    '--- НАЧАЛО ТРАНСКРИПТА ---',
    state.transcript.timestampedText || state.transcript.text || '(empty)',
    '--- КОНЕЦ ТРАНСКРИПТА ---',
  ]
    .filter(Boolean)
    .join('\n');
}

async function callLLM(extraMessages) {
  const messages = [
    { role: 'system', content: systemPrompt() },
    ...state.history,
    ...extraMessages,
  ];
  const resp = await send('LLM_CHAT', {
    payload: {
      messages,
      model: els.model.value || state.settings.model,
      temperature: parseFloat(els.temperature.value) || state.settings.temperature,
    },
  });
  if (!resp.ok) throw new Error(resp.error);
  return resp.content;
}

async function ask(question) {
  addMsg('user', question);
  const pending = addMsg('assistant', '…');
  setBusy(true);
  try {
    const answer = await callLLM([{ role: 'user', content: question }]);
    setMsgContent(pending, answer);
    state.history.push(
      { role: 'user', content: question },
      { role: 'assistant', content: answer }
    );
  } catch (e) {
    pending.remove();
    addMsg('error', e.message);
  } finally {
    setBusy(false);
  }
}

async function summarize() {
  if (!state.transcript) return;
  const prompt =
    'Сделай саммари этой лекции. Структуру и объём выбирай сам — как считаешь правильным. Используй Markdown для форматирования.';
  await ask(prompt);
}

// ----- init -----

els.settingsToggle.addEventListener('click', () =>
  els.settingsPanel.classList.toggle('hidden')
);
els.saveSettings.addEventListener('click', saveSettings);
els.reloadModels.addEventListener('click', refreshModels);
els.loadTranscript.addEventListener('click', loadTranscript);
els.summarize.addEventListener('click', summarize);
els.strictMode.addEventListener('click', () => {
  const active = els.strictMode.classList.toggle('active');
  els.strictMode.setAttribute('aria-pressed', String(active));
  chrome.storage.local.set({ strictMode: active });
});

els.askForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = els.askInput.value.trim();
  if (!q) return;
  els.askInput.value = '';
  ask(q);
});

chrome.webNavigation.onHistoryStateUpdated.addListener(
  async (details) => {
    if (details.frameId !== 0) return;
    const tab = await getActiveUdemyTab();
    if (!tab || tab.id !== details.tabId) return;
    loadTranscript();
  },
  { url: [{ hostEquals: 'www.udemy.com', pathContains: '/learn/lecture/' }] }
);

(async function init() {
  await loadSettings();
  const stored = await chrome.storage.local.get(['strictMode']);
  const strict = stored.strictMode ?? true;
  els.strictMode.classList.toggle('active', strict);
  els.strictMode.setAttribute('aria-pressed', String(strict));
  const tab = await getActiveUdemyTab();
  if (!tab) {
    addMsg('system', 'Open a Udemy lecture and click ↻.');
  }
})();
