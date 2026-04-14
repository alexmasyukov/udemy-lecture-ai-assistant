const $ = (sel) => document.querySelector(sel);

const els = {
  statusDot: $('#status-dot'),
  statusLabel: $('#status-label'),
  settingsToggle: $('#settings-toggle'),
  settingsPanel: $('#settings-panel'),
  providerLocal: $('#provider-local'),
  providerOpenai: $('#provider-openai'),
  localSettings: $('#local-settings'),
  openaiSettings: $('#openai-settings'),
  baseUrl: $('#baseUrl'),
  testBaseUrl: $('#test-base-url'),
  baseUrlResult: $('#base-url-result'),
  openaiApiKey: $('#openaiApiKey'),
  testOpenai: $('#test-openai'),
  openaiResult: $('#openai-result'),
  modelLocal: $('#model-local'),
  modelOpenai: $('#model-openai'),
  reloadModels: $('#reload-models'),
  reloadOpenaiModels: $('#reload-openai-models'),
  temperature: $('#temperature'),
  uiFontSize: $('#uiFontSize'),
  chatFontSize: $('#chatFontSize'),
  transparentAssistant: $('#transparentAssistant'),
  saveLocal: $('#save-local'),
  saveOpenai: $('#save-openai'),
  saveUi: $('#save-ui'),
  summaryPrompt: $('#summaryPrompt'),
  summaryExamplesPrompt: $('#summaryExamplesPrompt'),
  savePrompts: $('#save-prompts'),
  resetPrompts: $('#reset-prompts'),
  loadTranscript: $('#load-transcript'),
  summarize: $('#summarize'),
  summarizeExamples: $('#summarize-examples'),
  clearChat: $('#clear-chat'),
  menuToggle: $('#menu-toggle'),
  menu: $('#menu'),
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

marked.setOptions({
  gfm: true,
  breaks: true,
});

const renderer = new marked.Renderer();
const origCode = renderer.code.bind(renderer);
renderer.code = function ({ text, lang }) {
  const language = lang && hljs.getLanguage(lang) ? lang : null;
  const highlighted = language
    ? hljs.highlight(text, { language }).value
    : hljs.highlightAuto(text).value;
  const cls = language ? ` class="language-${language}"` : '';
  return `<pre><code${cls}>${highlighted}</code></pre>`;
};
marked.setOptions({ renderer });

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
  els.statusLabel.textContent =
    kind === 'ok' ? 'LLM connected' : kind === 'err' ? 'LLM offline' : 'LLM…';
}

function setBusy(busy) {
  state.busy = busy;
  els.askBtn.classList.toggle('hidden', busy);
  els.stopBtn.classList.toggle('hidden', !busy);
  els.summarize.disabled = busy;
  els.summarizeExamples.classList.toggle('disabled', busy);
}

// ----- settings -----

function applyFontSizes() {
  document.documentElement.style.setProperty('--ui-font', `${state.settings.uiFontSize}px`);
  document.documentElement.style.setProperty('--chat-font', `${state.settings.chatFontSize}px`);
}

function applyAppearance() {
  document.body.classList.toggle('transparent-assistant', Boolean(state.settings.transparentAssistant));
}

const OPENAI_BASE = 'https://api.openai.com/v1';
const OPENAI_MODELS = ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-4o', 'gpt-4o-mini'];

const DEFAULT_SUMMARY_PROMPT =
  'Сделай саммари этой лекции. Структуру и объём выбирай сам — как считаешь правильным. Используй Markdown для форматирования.';
const DEFAULT_SUMMARY_EXAMPLES_PROMPT =
  'Сделай саммари этой лекции. Структуру и объём выбирай сам — как считаешь правильным. Для каждой ключевой концепции приведи короткий рабочий пример на том языке программирования, о котором идёт речь в лекции. Примеры должны быть самодостаточными и демонстрировать именно тот момент, который обсуждается. Используй Markdown для форматирования.';

function currentProvider() {
  return els.providerOpenai.checked ? 'openai' : 'local';
}

function llmEndpoint() {
  if (currentProvider() === 'openai') {
    return {
      base: OPENAI_BASE,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${els.openaiApiKey.value.trim() || state.settings.openaiApiKey || ''}`,
      },
    };
  }
  return {
    base: (els.baseUrl.value.trim() || state.settings.baseUrl || 'http://127.0.0.1:1234/v1').replace(/\/$/, ''),
    headers: { 'Content-Type': 'application/json' },
  };
}

function applyProviderUi() {
  const isOpenai = currentProvider() === 'openai';
  els.localSettings.classList.toggle('hidden', isOpenai);
  els.openaiSettings.classList.toggle('hidden', !isOpenai);
}

async function loadSettings() {
  const resp = await send('GET_SETTINGS');
  state.settings = resp.settings;
  els.baseUrl.value = state.settings.baseUrl;
  els.openaiApiKey.value = state.settings.openaiApiKey || '';
  els.temperature.value = state.settings.temperature;
  els.uiFontSize.value = state.settings.uiFontSize;
  els.chatFontSize.value = state.settings.chatFontSize;
  els.transparentAssistant.checked = Boolean(state.settings.transparentAssistant);
  els.summaryPrompt.value = state.settings.summaryPrompt || DEFAULT_SUMMARY_PROMPT;
  els.summaryExamplesPrompt.value = state.settings.summaryExamplesPrompt || DEFAULT_SUMMARY_EXAMPLES_PROMPT;
  if (state.settings.provider === 'openai') {
    els.providerOpenai.checked = true;
  } else {
    els.providerLocal.checked = true;
  }
  applyProviderUi();
  applyFontSizes();
  applyAppearance();
  await refreshModels();
}

function populateOpenaiModels(list = OPENAI_MODELS) {
  const selected = state.settings?.openaiModel || list[0];
  els.modelOpenai.innerHTML = '';
  for (const id of list) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id;
    if (id === selected) opt.selected = true;
    els.modelOpenai.appendChild(opt);
  }
}

function isOpenaiChatModel(id) {
  if (!/^(gpt-|o1|o3|o4|chatgpt-)/i.test(id)) return false;
  if (/embed|whisper|tts|dall-e|moderation|audio|image|realtime|transcribe/i.test(id)) return false;
  return true;
}

async function fetchOpenaiModels() {
  const key = els.openaiApiKey.value.trim() || state.settings.openaiApiKey || '';
  if (!key) {
    populateOpenaiModels();
    return;
  }
  els.modelOpenai.innerHTML = '<option>loading…</option>';
  try {
    const r = await fetch(`${OPENAI_BASE}/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const ids = (j.data || [])
      .map((m) => m.id)
      .filter(isOpenaiChatModel)
      .sort();
    if (ids.length) {
      populateOpenaiModels(ids);
    } else {
      populateOpenaiModels();
    }
  } catch (e) {
    populateOpenaiModels();
    if (currentProvider() === 'openai') setStatus('err');
  }
}

async function refreshLocalModels() {
  const baseUrl = (els.baseUrl.value.trim() || state.settings?.baseUrl || 'http://127.0.0.1:1234/v1').replace(/\/$/, '');
  els.modelLocal.innerHTML = '<option>loading…</option>';
  let models = [];
  try {
    const r = await fetch(`${baseUrl}/models`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    models = (j.data || []).map((m) => m.id);
  } catch (e) {
    els.modelLocal.innerHTML = '';
    const opt = document.createElement('option');
    opt.textContent = `error: ${e.message}`;
    els.modelLocal.appendChild(opt);
    if (currentProvider() === 'local') setStatus('err');
    return;
  }
  els.modelLocal.innerHTML = '';
  if (!models.length) {
    const opt = document.createElement('option');
    opt.textContent = 'no models available';
    els.modelLocal.appendChild(opt);
    if (currentProvider() === 'local') setStatus('err');
    return;
  }
  for (const id of models) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id;
    if (id === state.settings.model) opt.selected = true;
    els.modelLocal.appendChild(opt);
  }
  updateProviderStatus();
}

function updateProviderStatus() {
  if (currentProvider() === 'openai') {
    const hasKey = (els.openaiApiKey.value.trim() || state.settings.openaiApiKey || '').length > 0;
    setStatus(hasKey && els.modelOpenai.value ? 'ok' : 'err');
  } else {
    setStatus(els.modelLocal.value ? 'ok' : 'err');
  }
}

async function refreshModels() {
  await Promise.all([fetchOpenaiModels(), refreshLocalModels()]);
  updateProviderStatus();
}

async function saveLocalSettings() {
  const next = {
    ...state.settings,
    baseUrl: els.baseUrl.value.trim() || 'http://127.0.0.1:1234/v1',
    model: els.modelLocal.value || state.settings.model,
    temperature: parseFloat(els.temperature.value) || 0.3,
  };
  await send('SAVE_SETTINGS', { settings: next });
  state.settings = next;
  addMsg('system', 'Local settings saved');
  await refreshLocalModels();
  updateProviderStatus();
}

async function saveOpenaiSettings() {
  const next = {
    ...state.settings,
    openaiApiKey: els.openaiApiKey.value.trim(),
    openaiModel: els.modelOpenai.value || state.settings.openaiModel,
  };
  await send('SAVE_SETTINGS', { settings: next });
  state.settings = next;
  addMsg('system', 'OpenAI settings saved');
  await fetchOpenaiModels();
  updateProviderStatus();
}

async function savePromptSettings() {
  const next = {
    ...state.settings,
    summaryPrompt: els.summaryPrompt.value.trim() || DEFAULT_SUMMARY_PROMPT,
    summaryExamplesPrompt: els.summaryExamplesPrompt.value.trim() || DEFAULT_SUMMARY_EXAMPLES_PROMPT,
  };
  await send('SAVE_SETTINGS', { settings: next });
  state.settings = next;
  addMsg('system', 'Prompts saved');
}

function resetPromptsToDefaults() {
  els.summaryPrompt.value = DEFAULT_SUMMARY_PROMPT;
  els.summaryExamplesPrompt.value = DEFAULT_SUMMARY_EXAMPLES_PROMPT;
}

async function saveUiSettings() {
  const next = {
    ...state.settings,
    uiFontSize: parseInt(els.uiFontSize.value, 10) || 13,
    chatFontSize: parseInt(els.chatFontSize.value, 10) || 16,
    transparentAssistant: els.transparentAssistant.checked,
  };
  await send('SAVE_SETTINGS', { settings: next });
  state.settings = next;
  applyFontSizes();
  applyAppearance();
  addMsg('system', 'UI settings saved');
}

async function saveProvider() {
  const next = { ...state.settings, provider: currentProvider() };
  await send('SAVE_SETTINGS', { settings: next });
  state.settings = next;
  updateProviderStatus();
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

function reasoningEffortFor(model) {
  // gpt-5.1, gpt-5.2, gpt-5.3, gpt-5.4… support "none" (full disable)
  if (/^gpt-5\.[1-9]/i.test(model)) return 'none';
  // gpt-5, gpt-5-mini, gpt-5-nano, o1, o3, o4-mini support only "low" minimum
  if (/^(gpt-5(-|$)|o1|o3|o4)/i.test(model)) return 'low';
  // gpt-4o, gpt-4, chatgpt-*: parameter is rejected
  return null;
}

async function streamChat({ messages, model, temperature, onDelta, signal }) {
  const { base, headers } = llmEndpoint();
  const url = `${base}/chat/completions`;
  const body = { model, messages, stream: true };
  if (currentProvider() === 'local') {
    body.temperature = temperature;
  } else {
    const effort = reasoningEffortFor(model);
    if (effort) body.reasoning_effort = effort;
  }
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name !== 'AbortError') setStatus('err');
    throw e;
  }
  if (!r.ok) {
    setStatus('err');
    const text = await r.text().catch(() => '');
    throw new Error(`LLM HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
  setStatus('ok');
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

async function ask(question, { skipHistory = false } = {}) {
  addMsg('user', question);
  const pending = addMsg('assistant', '…');
  const controller = new AbortController();
  state.abortController = controller;
  setBusy(true);
  let collected = '';
  try {
    const messages = [
      { role: 'system', content: systemPrompt() },
      ...(skipHistory ? [] : state.history),
      { role: 'user', content: question },
    ];
    const isOpenai = currentProvider() === 'openai';
    const activeModel = isOpenai
      ? els.modelOpenai.value || state.settings.openaiModel
      : els.modelLocal.value || state.settings.model;
    collected = await streamChat({
      messages,
      model: activeModel,
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
  if (!state.transcript) {
    await loadTranscript();
    if (!state.transcript) return;
  }
  const prompt = state.settings.summaryPrompt || DEFAULT_SUMMARY_PROMPT;
  await ask(prompt, { skipHistory: true });
}

async function summarizeWithExamples() {
  if (!state.transcript) {
    await loadTranscript();
    if (!state.transcript) return;
  }
  const prompt = state.settings.summaryExamplesPrompt || DEFAULT_SUMMARY_EXAMPLES_PROMPT;
  await ask(prompt, { skipHistory: true });
}

// ----- init -----

els.settingsToggle.addEventListener('click', () =>
  els.settingsPanel.classList.toggle('hidden')
);
els.saveLocal.addEventListener('click', saveLocalSettings);
els.saveOpenai.addEventListener('click', saveOpenaiSettings);
els.saveUi.addEventListener('click', saveUiSettings);
els.savePrompts.addEventListener('click', savePromptSettings);
els.resetPrompts.addEventListener('click', resetPromptsToDefaults);
els.providerLocal.addEventListener('change', () => {
  applyProviderUi();
  saveProvider();
});
els.providerOpenai.addEventListener('change', () => {
  applyProviderUi();
  saveProvider();
});
els.reloadModels.addEventListener('click', refreshLocalModels);
els.reloadOpenaiModels.addEventListener('click', fetchOpenaiModels);
els.testOpenai.addEventListener('click', async () => {
  const key = els.openaiApiKey.value.trim();
  if (!key) {
    els.openaiResult.textContent = 'enter API key first';
    els.openaiResult.style.color = 'var(--err)';
    return;
  }
  els.openaiResult.textContent = 'Testing…';
  els.openaiResult.style.color = 'var(--muted)';
  els.testOpenai.disabled = true;
  try {
    const r = await fetch(`${OPENAI_BASE}/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const count = (j.data || []).length;
    els.openaiResult.textContent = `OK · ${count} models available`;
    els.openaiResult.style.color = 'var(--ok)';
  } catch (e) {
    els.openaiResult.textContent = `Failed: ${e.message}`;
    els.openaiResult.style.color = 'var(--err)';
  } finally {
    els.testOpenai.disabled = false;
  }
});
els.testBaseUrl.addEventListener('click', async () => {
  const url = (els.baseUrl.value.trim() || 'http://127.0.0.1:1234/v1').replace(/\/$/, '');
  els.baseUrlResult.textContent = 'Testing…';
  els.baseUrlResult.style.color = 'var(--muted)';
  els.testBaseUrl.disabled = true;
  try {
    const r = await fetch(`${url}/models`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const count = (j.data || []).length;
    els.baseUrlResult.textContent = `OK · ${count} model${count === 1 ? '' : 's'}`;
    els.baseUrlResult.style.color = 'var(--ok)';
  } catch (e) {
    els.baseUrlResult.textContent = `Failed: ${e.message}`;
    els.baseUrlResult.style.color = 'var(--err)';
  } finally {
    els.testBaseUrl.disabled = false;
  }
});
els.loadTranscript.addEventListener('click', loadTranscript);
function closeMenu() {
  els.menu.classList.add('hidden');
  els.menuToggle.setAttribute('aria-expanded', 'false');
}

els.menuToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = els.menu.classList.toggle('hidden');
  els.menuToggle.setAttribute('aria-expanded', String(!open));
});
document.addEventListener('click', (e) => {
  if (!els.menu.contains(e.target) && e.target !== els.menuToggle) closeMenu();
});

els.summarize.addEventListener('click', () => {
  if (state.busy) return;
  summarize();
});
els.summarizeExamples.addEventListener('click', (e) => {
  e.preventDefault();
  if (state.busy) return;
  closeMenu();
  summarizeWithExamples();
});
els.stopBtn.addEventListener('click', () => {
  state.abortController?.abort();
});
els.clearChat.addEventListener('click', (e) => {
  e.preventDefault();
  closeMenu();
  if (!confirm('Точно удалить историю чата?')) return;
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

function autoresizeInput() {
  els.askInput.style.height = 'auto';
  els.askInput.style.height = `${els.askInput.scrollHeight}px`;
}

els.askInput.addEventListener('input', autoresizeInput);

els.askInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.altKey || e.shiftKey) return; // newline
  e.preventDefault();
  els.askForm.requestSubmit();
});

els.askForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (state.busy) return;
  const q = els.askInput.value.trim();
  if (!q) return;
  els.askInput.value = '';
  autoresizeInput();
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
