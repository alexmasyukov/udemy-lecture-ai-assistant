const $ = (sel) => document.querySelector(sel);

const els = {
  statusDot: $('#status-dot'),
  settingsToggle: $('#settings-toggle'),
  settingsPanel: $('#settings-panel'),
  baseUrl: $('#baseUrl'),
  model: $('#model'),
  reloadModels: $('#reload-models'),
  temperature: $('#temperature'),
  uiFontSize: $('#uiFontSize'),
  chatFontSize: $('#chatFontSize'),
  transparentAssistant: $('#transparentAssistant'),
  saveSettings: $('#save-settings'),
  loadTranscript: $('#load-transcript'),
  summarize: $('#summarize'),
  clearChat: $('#clear-chat'),
  stopBtn: $('#stop-btn'),
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
  busy: false,
  abortController: null,
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

marked.setOptions({ gfm: true, breaks: true });

const TS_TOKEN = /\d{1,2}:\d{2}(?::\d{2})?/;
const TS_BLOCK = /\[(\s*\d{1,2}:\d{2}(?::\d{2})?(?:\s*[,\-–—]\s*\d{1,2}:\d{2}(?::\d{2})?)*\s*)\]/g;

function tsToSeconds(ts) {
  const parts = ts.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return parts[0] * 60 + parts[1];
}

function wrapTs(ts) {
  return `<a href="#" class="ts-link" data-seek="${tsToSeconds(ts)}">${ts}</a>`;
}

function linkifyTimestamps(html) {
  return html.replace(TS_BLOCK, (_, inner) => {
    const parts = inner.split(/(\s*[,\-–—]\s*)/);
    const rebuilt = parts
      .map((p) => (TS_TOKEN.test(p) && /^\d/.test(p) ? wrapTs(p) : p))
      .join('');
    return `[${rebuilt}]`;
  });
}

function setMsgContent(div, text) {
  if (div.classList.contains('assistant')) {
    div.innerHTML = linkifyTimestamps(marked.parse(text || ''));
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
  state.busy = busy;
  els.askBtn.classList.toggle('hidden', busy);
  els.stopBtn.classList.toggle('hidden', !busy);
  els.summarize.disabled = busy || !state.transcript;
}

// ----- settings -----

function applyFontSizes() {
  document.documentElement.style.setProperty('--ui-font', `${state.settings.uiFontSize}px`);
  document.documentElement.style.setProperty('--chat-font', `${state.settings.chatFontSize}px`);
}

function applyAppearance() {
  document.body.classList.toggle('transparent-assistant', Boolean(state.settings.transparentAssistant));
}

async function loadSettings() {
  const resp = await send('GET_SETTINGS');
  state.settings = resp.settings;
  els.baseUrl.value = state.settings.baseUrl;
  els.temperature.value = state.settings.temperature;
  els.uiFontSize.value = state.settings.uiFontSize;
  els.chatFontSize.value = state.settings.chatFontSize;
  els.transparentAssistant.checked = Boolean(state.settings.transparentAssistant);
  applyFontSizes();
  applyAppearance();
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
    uiFontSize: parseInt(els.uiFontSize.value, 10) || 13,
    chatFontSize: parseInt(els.chatFontSize.value, 10) || 16,
    transparentAssistant: els.transparentAssistant.checked,
  };
  await send('SAVE_SETTINGS', { settings: next });
  state.settings = next;
  applyFontSizes();
  applyAppearance();
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

async function streamChat({ messages, model, temperature, onDelta, signal }) {
  const url = `${state.settings.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature, messages, stream: true }),
    signal,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`LLM HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return content;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          content += delta;
          onDelta(content);
        }
      } catch {
        /* keep going — partial JSON, rarely happens with line-based SSE */
      }
    }
  }
  return content;
}

async function ask(question) {
  addMsg('user', question);
  const pending = addMsg('assistant', '…');
  const controller = new AbortController();
  state.abortController = controller;
  setBusy(true);
  let collected = '';
  try {
    const messages = [
      { role: 'system', content: systemPrompt() },
      ...state.history,
      { role: 'user', content: question },
    ];
    collected = await streamChat({
      messages,
      model: els.model.value || state.settings.model,
      temperature: parseFloat(els.temperature.value) || state.settings.temperature,
      signal: controller.signal,
      onDelta: (content) => {
        collected = content;
        const atBottom =
          els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 40;
        setMsgContent(pending, content);
        if (atBottom) els.messages.scrollTop = els.messages.scrollHeight;
      },
    });
    if (!collected) setMsgContent(pending, '(empty response)');
    state.history.push(
      { role: 'user', content: question },
      { role: 'assistant', content: collected }
    );
  } catch (e) {
    if (e.name === 'AbortError') {
      if (collected) {
        state.history.push(
          { role: 'user', content: question },
          { role: 'assistant', content: collected }
        );
      } else {
        pending.remove();
      }
    } else {
      pending.remove();
      addMsg('error', e.message);
    }
  } finally {
    state.abortController = null;
    setBusy(false);
    els.askInput.focus();
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
els.stopBtn.addEventListener('click', () => {
  state.abortController?.abort();
});
els.clearChat.addEventListener('click', (e) => {
  e.preventDefault();
  state.abortController?.abort();
  state.history = [];
  els.messages.innerHTML = '';
  els.askInput.focus();
});
els.messages.addEventListener('click', async (e) => {
  const link = e.target.closest('a.ts-link');
  if (!link) return;
  e.preventDefault();
  const seconds = parseFloat(link.dataset.seek);
  if (!Number.isFinite(seconds)) return;
  const tab = await getActiveUdemyTab();
  if (!tab) return;
  try {
    await sendToTab(tab.id, { type: 'SEEK_TO', seconds });
  } catch (err) {
    addMsg('error', `Seek failed: ${err.message}`);
  }
});

els.strictMode.addEventListener('click', () => {
  const active = els.strictMode.classList.toggle('active');
  els.strictMode.setAttribute('aria-pressed', String(active));
  chrome.storage.local.set({ strictMode: active });
});

els.askForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (state.busy) return;
  const q = els.askInput.value.trim();
  if (!q) return;
  els.askInput.value = '';
  ask(q);
  els.askInput.focus();
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
