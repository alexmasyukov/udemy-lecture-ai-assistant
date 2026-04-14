import {
  DEFAULTS,
  DEFAULT_SUMMARY_PROMPT,
  DEFAULT_SUMMARY_EXAMPLES_PROMPT,
  OPENAI_FALLBACK_MODELS,
} from './src/defaults.js';
import { loadSettings, patchSettings } from './src/settings.js';
import {
  providers,
  getProvider,
  streamChat,
  testEndpoint,
  normalizeBaseUrl,
} from './src/providers.js';
import { configureMarked } from './src/markdown.js';
import {
  getActiveUdemyTab,
  sendToTab,
  buildSystemPrompt,
} from './src/transcript.js';
import {
  els,
  addMsg,
  setMsgContent,
  setStatus,
  setBusy,
  applyFontSizes,
  applyAppearance,
  autoresizeInput,
  setInlineResult,
  populateSelect,
} from './src/ui.js';

configureMarked();

const state = {
  transcript: null, // { source, text, timestampedText, cues }
  meta: null,
  history: [],
  settings: { ...DEFAULTS },
  busy: false,
  abortController: null,
  openrouterModelsFull: [], // [{ id, label, contextLength }]
};

// ----- settings flow -----

function currentProviderName() {
  if (els.providerOpenai.checked) return 'openai';
  if (els.providerOpenrouter.checked) return 'openrouter';
  return 'local';
}

function applyProviderUi() {
  const name = currentProviderName();
  els.localSettings.classList.toggle('hidden', name !== 'local');
  els.openaiSettings.classList.toggle('hidden', name !== 'openai');
  els.openrouterSettings.classList.toggle('hidden', name !== 'openrouter');
}

function updateProviderStatus() {
  const name = currentProviderName();
  if (name === 'openai') {
    const hasKey = (els.openaiApiKey.value.trim() || state.settings.openaiApiKey || '').length > 0;
    setStatus(hasKey && els.modelOpenai.value ? 'ok' : 'err');
  } else if (name === 'openrouter') {
    const hasKey = (els.openrouterApiKey.value.trim() || state.settings.openrouterApiKey || '').length > 0;
    setStatus(hasKey && els.modelOpenrouter.value ? 'ok' : 'err');
  } else {
    setStatus(els.modelLocal.value ? 'ok' : 'err');
  }
}

function readFormIntoSettings() {
  // Settings currently live in the DOM (inputs) as the source of truth
  // while a form is open. Snapshot them back into state.settings so
  // subsequent reads see edits even before Save is pressed.
  return {
    ...state.settings,
    provider: currentProviderName(),
    baseUrl: els.baseUrl.value.trim() || DEFAULTS.baseUrl,
    openaiApiKey: els.openaiApiKey.value.trim(),
    openrouterApiKey: els.openrouterApiKey.value.trim(),
    temperature: parseFloat(els.temperature.value) || state.settings.temperature,
  };
}

async function refreshLocalModels() {
  const snapshot = readFormIntoSettings();
  els.modelLocal.innerHTML = '<option>loading…</option>';
  try {
    const ids = await providers.local.listModels(snapshot);
    populateSelect(els.modelLocal, ids, state.settings.model);
  } catch (e) {
    els.modelLocal.innerHTML = '';
    const opt = document.createElement('option');
    opt.textContent = `error: ${e.message}`;
    els.modelLocal.appendChild(opt);
  } finally {
    updateProviderStatus();
  }
}

async function refreshOpenaiModels() {
  const snapshot = readFormIntoSettings();
  if (!snapshot.openaiApiKey) {
    populateSelect(els.modelOpenai, OPENAI_FALLBACK_MODELS, state.settings.openaiModel);
    updateProviderStatus();
    return;
  }
  els.modelOpenai.innerHTML = '<option>loading…</option>';
  try {
    const ids = await providers.openai.listModels(snapshot);
    populateSelect(
      els.modelOpenai,
      ids.length ? ids : OPENAI_FALLBACK_MODELS,
      state.settings.openaiModel,
    );
  } catch {
    populateSelect(els.modelOpenai, OPENAI_FALLBACK_MODELS, state.settings.openaiModel);
  } finally {
    updateProviderStatus();
  }
}

function renderOpenrouterSelect() {
  const query = els.openrouterFilter.value.trim().toLowerCase();
  const words = query ? query.split(/\s+/) : [];
  const full = state.openrouterModelsFull;
  const filtered = words.length
    ? full.filter((m) => {
        const hay = `${m.id} ${m.label}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
    : full;
  els.modelOpenrouter.innerHTML = '';
  if (!filtered.length) {
    const opt = document.createElement('option');
    opt.textContent = full.length ? 'no matches' : 'no models loaded';
    els.modelOpenrouter.appendChild(opt);
  } else {
    const selected = state.settings.openrouterModel;
    for (const m of filtered) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      if (m.id === selected) opt.selected = true;
      els.modelOpenrouter.appendChild(opt);
    }
    // If the saved model isn't in the filtered set, prepend it as a
    // "ghost" option so the user sees what's currently selected.
    if (selected && !filtered.some((m) => m.id === selected)) {
      const ghost = document.createElement('option');
      ghost.value = selected;
      ghost.textContent = `${selected} (not in filter)`;
      ghost.selected = true;
      els.modelOpenrouter.prepend(ghost);
    }
  }
  els.openrouterModelCount.textContent = full.length
    ? `${filtered.length} / ${full.length} models`
    : '';
}

async function refreshOpenrouterModels() {
  const snapshot = readFormIntoSettings();
  els.modelOpenrouter.innerHTML = '<option>loading…</option>';
  try {
    const items = await providers.openrouter.listModels(snapshot);
    state.openrouterModelsFull = items;
    renderOpenrouterSelect();
  } catch (e) {
    state.openrouterModelsFull = [];
    els.modelOpenrouter.innerHTML = '';
    const opt = document.createElement('option');
    opt.textContent = `error: ${e.message}`;
    els.modelOpenrouter.appendChild(opt);
    els.openrouterModelCount.textContent = '';
  } finally {
    updateProviderStatus();
  }
}

async function refreshAllModels() {
  await Promise.all([
    refreshLocalModels(),
    refreshOpenaiModels(),
    refreshOpenrouterModels(),
  ]);
}

async function applySettings(settings) {
  state.settings = settings;
  els.baseUrl.value = settings.baseUrl;
  els.openaiApiKey.value = settings.openaiApiKey || '';
  els.openrouterApiKey.value = settings.openrouterApiKey || '';
  els.temperature.value = settings.temperature;
  els.uiFontSize.value = settings.uiFontSize;
  els.chatFontSize.value = settings.chatFontSize;
  els.transparentAssistant.checked = Boolean(settings.transparentAssistant);
  els.summaryPrompt.value = settings.summaryPrompt || DEFAULT_SUMMARY_PROMPT;
  els.summaryExamplesPrompt.value = settings.summaryExamplesPrompt || DEFAULT_SUMMARY_EXAMPLES_PROMPT;
  if (settings.provider === 'openai') {
    els.providerOpenai.checked = true;
  } else if (settings.provider === 'openrouter') {
    els.providerOpenrouter.checked = true;
  } else {
    els.providerLocal.checked = true;
  }
  els.strictMode.classList.toggle('active', Boolean(settings.strictMode));
  els.strictMode.setAttribute('aria-pressed', String(Boolean(settings.strictMode)));
  applyProviderUi();
  applyFontSizes(settings);
  applyAppearance(settings);
}

async function savePatch(patch, toast) {
  state.settings = await patchSettings(patch);
  if (toast) addMsg('system', toast);
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
      `${title} — ${t.source.toUpperCase()}${localeStr} · ${t.cues.length} cues · ${t.text.length.toLocaleString()} chars · lecture ${resp.meta.lectureId || '?'}`,
    );
    toggleBusy(false);
  } catch (e) {
    addMsg('error', `Could not load transcript: ${e.message}`);
  } finally {
    els.loadTranscript.disabled = false;
  }
}

// ----- chat -----

function toggleBusy(busy) {
  state.busy = busy;
  setBusy(busy);
}

function systemPrompt() {
  return buildSystemPrompt({
    transcript: state.transcript,
    meta: state.meta,
    strictMode: els.strictMode.classList.contains('active'),
  });
}

function activeModel() {
  const name = currentProviderName();
  if (name === 'openai') return els.modelOpenai.value || state.settings.openaiModel;
  if (name === 'openrouter') return els.modelOpenrouter.value || state.settings.openrouterModel;
  return els.modelLocal.value || state.settings.model;
}

async function ask(question, { skipHistory = false } = {}) {
  addMsg('user', question);
  const pending = addMsg('assistant', '…');
  const controller = new AbortController();
  state.abortController = controller;
  toggleBusy(true);
  let collected = '';
  try {
    const messages = [
      { role: 'system', content: systemPrompt() },
      ...(skipHistory ? [] : state.history),
      { role: 'user', content: question },
    ];
    const snapshot = readFormIntoSettings();
    const provider = providers[currentProviderName()];
    collected = await streamChat({
      provider,
      settings: snapshot,
      messages,
      model: activeModel(),
      temperature: snapshot.temperature,
      signal: controller.signal,
      onDelta: (content) => {
        collected = content;
        const atBottom =
          els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 40;
        setMsgContent(pending, content);
        if (atBottom) els.messages.scrollTop = els.messages.scrollHeight;
      },
    });
    setStatus('ok');
    if (!collected) setMsgContent(pending, '(empty response)');
    state.history.push(
      { role: 'user', content: question },
      { role: 'assistant', content: collected },
    );
  } catch (e) {
    if (e.name === 'AbortError') {
      if (collected) {
        state.history.push(
          { role: 'user', content: question },
          { role: 'assistant', content: collected },
        );
      } else {
        pending.remove();
      }
    } else {
      pending.remove();
      addMsg('error', e.message);
      setStatus('err');
    }
  } finally {
    state.abortController = null;
    toggleBusy(false);
    els.askInput.focus();
  }
}

async function summarizeWith(prompt) {
  if (!state.transcript) {
    await loadTranscript();
    if (!state.transcript) return;
  }
  await ask(prompt, { skipHistory: true });
}

// ----- event wiring -----

function closeMenu() {
  els.menu.classList.add('hidden');
  els.menuToggle.setAttribute('aria-expanded', 'false');
}

function wireSettingsTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.tab-panel').forEach((p) =>
        p.classList.toggle('active', p.dataset.tabPanel === target),
      );
    });
  });
}

function wireSettingsForms() {
  els.settingsToggle.addEventListener('click', () =>
    els.settingsPanel.classList.toggle('hidden'),
  );

  els.saveLocal.addEventListener('click', async () => {
    await savePatch(
      {
        baseUrl: els.baseUrl.value.trim() || DEFAULTS.baseUrl,
        model: els.modelLocal.value || state.settings.model,
        temperature: parseFloat(els.temperature.value) || DEFAULTS.temperature,
      },
      'Local settings saved',
    );
    await refreshLocalModels();
  });

  els.saveOpenai.addEventListener('click', async () => {
    await savePatch(
      {
        openaiApiKey: els.openaiApiKey.value.trim(),
        openaiModel: els.modelOpenai.value || state.settings.openaiModel,
      },
      'OpenAI settings saved',
    );
    await refreshOpenaiModels();
  });

  els.saveOpenrouter.addEventListener('click', async () => {
    await savePatch(
      {
        openrouterApiKey: els.openrouterApiKey.value.trim(),
        openrouterModel: els.modelOpenrouter.value || state.settings.openrouterModel,
      },
      'OpenRouter settings saved',
    );
    await refreshOpenrouterModels();
  });

  els.saveUi.addEventListener('click', async () => {
    await savePatch(
      {
        uiFontSize: parseInt(els.uiFontSize.value, 10) || DEFAULTS.uiFontSize,
        chatFontSize: parseInt(els.chatFontSize.value, 10) || DEFAULTS.chatFontSize,
        transparentAssistant: els.transparentAssistant.checked,
      },
      'UI settings saved',
    );
    applyFontSizes(state.settings);
    applyAppearance(state.settings);
  });

  els.savePrompts.addEventListener('click', async () => {
    await savePatch(
      {
        summaryPrompt: els.summaryPrompt.value.trim() || DEFAULT_SUMMARY_PROMPT,
        summaryExamplesPrompt: els.summaryExamplesPrompt.value.trim() || DEFAULT_SUMMARY_EXAMPLES_PROMPT,
      },
      'Prompts saved',
    );
  });

  els.resetPrompts.addEventListener('click', () => {
    els.summaryPrompt.value = DEFAULT_SUMMARY_PROMPT;
    els.summaryExamplesPrompt.value = DEFAULT_SUMMARY_EXAMPLES_PROMPT;
  });

  const onProviderChange = async () => {
    applyProviderUi();
    await savePatch({ provider: currentProviderName() });
    updateProviderStatus();
  };
  els.providerLocal.addEventListener('change', onProviderChange);
  els.providerOpenai.addEventListener('change', onProviderChange);
  els.providerOpenrouter.addEventListener('change', onProviderChange);

  els.reloadModels.addEventListener('click', refreshLocalModels);
  els.reloadOpenaiModels.addEventListener('click', refreshOpenaiModels);
  els.reloadOpenrouterModels.addEventListener('click', refreshOpenrouterModels);
  els.openrouterFilter.addEventListener('input', renderOpenrouterSelect);

  els.testBaseUrl.addEventListener('click', async () => {
    setInlineResult(els.baseUrlResult, 'Testing…', null);
    els.testBaseUrl.disabled = true;
    try {
      const base = normalizeBaseUrl(els.baseUrl.value);
      const count = await testEndpoint({ base, headers: {} });
      setInlineResult(els.baseUrlResult, `OK · ${count} model${count === 1 ? '' : 's'}`, 'ok');
    } catch (e) {
      setInlineResult(els.baseUrlResult, `Failed: ${e.message}`, 'err');
    } finally {
      els.testBaseUrl.disabled = false;
    }
  });

  els.testOpenai.addEventListener('click', async () => {
    const key = els.openaiApiKey.value.trim();
    if (!key) {
      setInlineResult(els.openaiResult, 'enter API key first', 'err');
      return;
    }
    setInlineResult(els.openaiResult, 'Testing…', null);
    els.testOpenai.disabled = true;
    try {
      const { base, headers } = providers.openai.endpoint({ openaiApiKey: key });
      const count = await testEndpoint({ base, headers });
      setInlineResult(els.openaiResult, `OK · ${count} models available`, 'ok');
    } catch (e) {
      setInlineResult(els.openaiResult, `Failed: ${e.message}`, 'err');
    } finally {
      els.testOpenai.disabled = false;
    }
  });

  els.testOpenrouter.addEventListener('click', async () => {
    const key = els.openrouterApiKey.value.trim();
    if (!key) {
      setInlineResult(els.openrouterResult, 'enter API key first', 'err');
      return;
    }
    setInlineResult(els.openrouterResult, 'Testing…', null);
    els.testOpenrouter.disabled = true;
    try {
      const { base, headers } = providers.openrouter.endpoint({ openrouterApiKey: key });
      const count = await testEndpoint({ base, headers });
      setInlineResult(els.openrouterResult, `OK · ${count} models available`, 'ok');
    } catch (e) {
      setInlineResult(els.openrouterResult, `Failed: ${e.message}`, 'err');
    } finally {
      els.testOpenrouter.disabled = false;
    }
  });
}

function wireChrome() {
  els.loadTranscript.addEventListener('click', loadTranscript);

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
    summarizeWith(state.settings.summaryPrompt || DEFAULT_SUMMARY_PROMPT);
  });
  els.summarizeExamples.addEventListener('click', (e) => {
    e.preventDefault();
    if (state.busy) return;
    closeMenu();
    summarizeWith(state.settings.summaryExamplesPrompt || DEFAULT_SUMMARY_EXAMPLES_PROMPT);
  });

  els.stopBtn.addEventListener('click', () => state.abortController?.abort());

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

  els.strictMode.addEventListener('click', async () => {
    const active = els.strictMode.classList.toggle('active');
    els.strictMode.setAttribute('aria-pressed', String(active));
    await savePatch({ strictMode: active });
  });
}

function wireComposer() {
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
}

function wireNavigation() {
  chrome.webNavigation.onHistoryStateUpdated.addListener(
    async (details) => {
      if (details.frameId !== 0) return;
      const tab = await getActiveUdemyTab();
      if (!tab || tab.id !== details.tabId) return;
      loadTranscript();
    },
    { url: [{ hostEquals: 'www.udemy.com', pathContains: '/learn/lecture/' }] },
  );
}

// ----- init -----

(async function init() {
  wireSettingsTabs();
  wireSettingsForms();
  wireChrome();
  wireComposer();
  wireNavigation();

  const settings = await loadSettings();
  await applySettings(settings);
  await refreshAllModels();

  const tab = await getActiveUdemyTab();
  if (!tab) {
    addMsg('system', 'Open a Udemy lecture and click ↻.');
  }
})();
