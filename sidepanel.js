import {
  DEFAULTS,
  DEFAULT_SUMMARY_PROMPT,
  DEFAULT_SUMMARY_EXAMPLES_PROMPT,
  MEMORY_BASE_FALLBACK,
} from './src/defaults.js';
import { loadSettings, patchSettings } from './src/settings.js';
import {
  providers,
  getActiveProvider,
  streamChat,
} from './src/providers.js';
import { configureMarked } from './src/markdown.js';
import {
  getActiveUdemyTab,
  sendToTab,
  buildSystemPrompt,
} from './src/transcript.js';
import * as memory from './src/memory.js';
import {
  els,
  addMsg,
  setMsgContent,
  setStatus,
  setMemoryStatus,
  setBusy,
  applyFontSizes,
  applyAppearance,
  autoresizeInput,
  setInlineResult,
} from './src/ui.js';

configureMarked();

const state = {
  transcript: null,
  meta: null,
  history: [],
  settings: { ...DEFAULTS },
  busy: false,
  abortController: null,
  // DOM ref to the rendered "saved summary" anchor (first .msg.assistant
  // at the very top of #messages). Tracked so regenerating a summary
  // can replace the old one in place instead of appending.
  summaryEl: null,
};

// ----- settings -----

function activeProvider() {
  return getActiveProvider(state.settings);
}

function effectiveSettings() {
  let merged = { ...state.settings };
  for (const p of Object.values(providers)) {
    merged = { ...merged, ...p.readFormOverrides() };
  }
  return merged;
}

function applyProviderVisibility() {
  for (const p of Object.values(providers)) {
    els[p.ui.fieldset].classList.toggle('hidden', p.name !== state.settings.provider);
    els[p.ui.radio].checked = p.name === state.settings.provider;
  }
}

function updateProviderStatus() {
  setStatus(activeProvider().isConnected(state.settings) ? 'ok' : 'err');
}

const UI_BINDINGS = [
  ['uiFontSize', 'uiFontSize', 'value'],
  ['chatFontSize', 'chatFontSize', 'value'],
  ['transparentAssistant', 'transparentAssistant', 'checked'],
  ['summaryPrompt', 'summaryPrompt', 'value'],
  ['summaryExamplesPrompt', 'summaryExamplesPrompt', 'value'],
  ['memoryBaseUrl', 'memoryBaseUrl', 'value'],
  ['memoryEnabled', 'memoryEnabled', 'checked'],
];

function applySettings(settings) {
  state.settings = settings;
  for (const [elKey, settingKey, prop] of UI_BINDINGS) {
    els[elKey][prop] = settings[settingKey] ?? DEFAULTS[settingKey];
  }
  for (const p of Object.values(providers)) {
    p.applyToForm(settings);
  }
  els.strictMode.classList.toggle('active', Boolean(settings.strictMode));
  els.strictMode.setAttribute('aria-pressed', String(Boolean(settings.strictMode)));
  applyProviderVisibility();
  applyFontSizes(settings);
  applyAppearance(settings);
}

async function savePatch(patch, toast) {
  state.settings = await patchSettings(patch);
  if (toast) addMsg('system', toast);
}

async function refreshAllProviders() {
  const eff = effectiveSettings();
  await Promise.all(Object.values(providers).map((p) => p.refresh(eff)));
  updateProviderStatus();
}

// ----- memory -----

memory.onMemoryStatus((online) => {
  if (!state.settings.memoryEnabled) {
    setMemoryStatus(null);
  } else {
    setMemoryStatus(online ? 'ok' : 'err');
  }
});

async function refreshMemoryStatus() {
  if (!state.settings.memoryEnabled) {
    setMemoryStatus(null);
    return;
  }
  const ok = await memory.health(state.settings);
  setMemoryStatus(ok ? 'ok' : 'err');
}

function lectureKey() {
  const m = state.meta;
  if (!m?.courseId || !m?.lectureId) return null;
  return { course_id: String(m.courseId), lecture_id: String(m.lectureId) };
}

async function restoreFromMemory() {
  if (!state.settings.memoryEnabled) return;
  const key = lectureKey();
  if (!key) return;
  const eff = effectiveSettings();
  const [lection, history] = await Promise.all([
    memory.getLectionByKey(eff, key),
    memory.listHistory(eff, key),
  ]);
  if (lection?.summary) {
    state.summaryEl = addMsg('assistant', lection.summary, { extraClass: 'summary-anchor' });
    state.history.push({ role: 'assistant', content: lection.summary });
  }
  for (const m of history) {
    const role = m.kind === 'q' ? 'user' : 'assistant';
    addMsg(role, m.content);
    state.history.push({ role, content: m.content });
  }
}

// ----- transcript -----

async function loadTranscript() {
  const tab = await getActiveUdemyTab();
  if (!tab) {
    addMsg('error', 'Open a Udemy lecture page first.');
    return;
  }

  // Reset chat for new lecture (or reload of same one)
  state.transcript = null;
  state.meta = null;
  state.history = [];
  state.summaryEl = null;
  els.messages.innerHTML = '';

  els.loadTranscript.disabled = true;
  try {
    const resp = await sendToTab(tab.id, { type: 'GET_TRANSCRIPT' });
    if (!resp?.ok) throw new Error(resp?.error || 'no response from content script');
    state.transcript = resp.transcript;
    state.meta = resp.meta;

    // Restore saved summary + chat history first so the lecture-info
    // line appears below them (chronological order from user POV).
    await restoreFromMemory();

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

async function ask(question) {
  addMsg('user', question);
  const pending = addMsg('assistant', '…');
  const controller = new AbortController();
  state.abortController = controller;
  toggleBusy(true);
  let collected = '';

  const eff = effectiveSettings();
  const provider = activeProvider();
  const model = provider.activeModel(eff);
  const key = lectureKey();
  const memOn = state.settings.memoryEnabled && Boolean(key);

  if (memOn) {
    memory.addMessage(eff, { ...key, kind: 'q', content: question });
  }

  try {
    const messages = [
      { role: 'system', content: systemPrompt() },
      ...state.history,
      { role: 'user', content: question },
    ];
    collected = await streamChat({
      provider,
      settings: eff,
      messages,
      model,
      temperature: eff.temperature,
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
    if (collected && memOn) {
      memory.addMessage(eff, { ...key, kind: 'a', content: collected, model });
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      if (collected) {
        state.history.push(
          { role: 'user', content: question },
          { role: 'assistant', content: collected },
        );
        if (memOn) {
          memory.addMessage(eff, { ...key, kind: 'a', content: collected, model });
        }
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

// ----- summarize -----
//
// Different from `ask`: doesn't write to /history (saved into
// lections.summary instead), doesn't show the prompt as a user message,
// streams into a single anchored assistant block at the very top of the
// chat, and replaces it on regeneration.
async function runSummary(prompt) {
  if (!state.transcript) {
    await loadTranscript();
    if (!state.transcript) return;
  }

  // Drop previous summary anchor (DOM + first item in state.history if it's the summary).
  if (state.summaryEl) {
    state.summaryEl.remove();
    state.summaryEl = null;
    if (state.history[0]?.role === 'assistant') state.history.shift();
  }

  const summaryEl = addMsg('assistant', '…', { prepend: true, extraClass: 'summary-anchor' });
  state.summaryEl = summaryEl;
  summaryEl.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const controller = new AbortController();
  state.abortController = controller;
  toggleBusy(true);
  let collected = '';

  const eff = effectiveSettings();
  const provider = activeProvider();
  const model = provider.activeModel(eff);

  try {
    const messages = [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: prompt },
    ];
    collected = await streamChat({
      provider,
      settings: eff,
      messages,
      model,
      temperature: eff.temperature,
      signal: controller.signal,
      onDelta: (content) => {
        collected = content;
        setMsgContent(summaryEl, content);
      },
    });
    setStatus('ok');
    if (!collected) {
      setMsgContent(summaryEl, '(empty response)');
      return;
    }
    state.history.unshift({ role: 'assistant', content: collected });
    persistSummary(collected, model, eff);
  } catch (e) {
    if (e.name === 'AbortError') {
      if (collected) {
        state.history.unshift({ role: 'assistant', content: collected });
        persistSummary(collected, model, eff);
      } else {
        summaryEl.remove();
        state.summaryEl = null;
      }
    } else {
      summaryEl.remove();
      state.summaryEl = null;
      addMsg('error', e.message);
      setStatus('err');
    }
  } finally {
    state.abortController = null;
    toggleBusy(false);
  }
}

function persistSummary(summary, model, eff) {
  const key = lectureKey();
  if (!key || !state.settings.memoryEnabled) return;
  memory.upsertLection(eff, {
    ...key,
    title: state.meta?.lectureTitle || 'Lecture',
    url: state.meta?.url || null,
    transcript: state.transcript?.timestampedText || state.transcript?.text || null,
    summary,
    summary_model: model,
  });
}

// ----- wiring -----

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

function wireProvider(provider) {
  const { ui } = provider;

  els[ui.radio].addEventListener('change', async () => {
    await savePatch({ provider: provider.name });
    applyProviderVisibility();
    updateProviderStatus();
  });

  els[ui.save].addEventListener('click', async () => {
    await savePatch(provider.collectFormPatch(), `${provider.label} settings saved`);
    await provider.refresh(effectiveSettings());
    updateProviderStatus();
  });

  if (ui.modelReload) {
    els[ui.modelReload].addEventListener('click', async () => {
      await provider.refresh(effectiveSettings());
      updateProviderStatus();
    });
  }

  const testBtnKey = ui.apiKeyTest || ui.baseUrlTest;
  const resultElKey = ui.apiKeyResult || ui.baseUrlResult;
  if (testBtnKey && resultElKey) {
    els[testBtnKey].addEventListener('click', async () => {
      setInlineResult(els[resultElKey], 'Testing…', null);
      els[testBtnKey].disabled = true;
      try {
        const count = await provider.testCredentials();
        setInlineResult(
          els[resultElKey],
          `OK · ${count} model${count === 1 ? '' : 's'} available`,
          'ok',
        );
      } catch (e) {
        setInlineResult(els[resultElKey], `Failed: ${e.message}`, 'err');
      } finally {
        els[testBtnKey].disabled = false;
      }
    });
  }

  if (ui.filter && provider.onFilterInput) {
    els[ui.filter].addEventListener('input', () =>
      provider.onFilterInput(state.settings),
    );
  }
}

function wireMemoryForm() {
  els.saveMemory.addEventListener('click', async () => {
    await savePatch(
      {
        memoryBaseUrl: els.memoryBaseUrl.value.trim() || MEMORY_BASE_FALLBACK,
        memoryEnabled: els.memoryEnabled.checked,
      },
      'Memory settings saved',
    );
    await refreshMemoryStatus();
  });

  els.testMemory.addEventListener('click', async () => {
    setInlineResult(els.memoryResult, 'Testing…', null);
    els.testMemory.disabled = true;
    try {
      const probe = {
        memoryEnabled: true,
        memoryBaseUrl: els.memoryBaseUrl.value.trim() || MEMORY_BASE_FALLBACK,
      };
      const ok = await memory.health(probe);
      setInlineResult(
        els.memoryResult,
        ok ? 'OK · backend reachable' : 'Failed: no response from backend',
        ok ? 'ok' : 'err',
      );
    } finally {
      els.testMemory.disabled = false;
    }
  });
}

function wireSettingsForms() {
  els.settingsToggle.addEventListener('click', () =>
    els.settingsPanel.classList.toggle('hidden'),
  );

  for (const p of Object.values(providers)) {
    wireProvider(p);
  }

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
        summaryExamplesPrompt:
          els.summaryExamplesPrompt.value.trim() || DEFAULT_SUMMARY_EXAMPLES_PROMPT,
      },
      'Prompts saved',
    );
  });

  els.resetPrompts.addEventListener('click', () => {
    els.summaryPrompt.value = DEFAULT_SUMMARY_PROMPT;
    els.summaryExamplesPrompt.value = DEFAULT_SUMMARY_EXAMPLES_PROMPT;
  });

  wireMemoryForm();
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
    runSummary(state.settings.summaryPrompt || DEFAULT_SUMMARY_PROMPT);
  });
  els.summarizeExamples.addEventListener('click', (e) => {
    e.preventDefault();
    if (state.busy) return;
    closeMenu();
    runSummary(state.settings.summaryExamplesPrompt || DEFAULT_SUMMARY_EXAMPLES_PROMPT);
  });

  els.stopBtn.addEventListener('click', () => state.abortController?.abort());

  els.clearChat.addEventListener('click', (e) => {
    e.preventDefault();
    closeMenu();
    if (!confirm('Точно удалить историю чата?')) return;
    state.abortController?.abort();
    state.history = [];
    state.summaryEl = null;
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
    if (e.altKey || e.shiftKey) return;
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

  applySettings(await loadSettings());
  await Promise.all([refreshAllProviders(), refreshMemoryStatus()]);

  const tab = await getActiveUdemyTab();
  if (!tab) {
    addMsg('system', 'Open a Udemy lecture and click ↻.');
  }
})();
