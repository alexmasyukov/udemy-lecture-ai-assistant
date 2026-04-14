import {
  DEFAULTS,
  DEFAULT_SUMMARY_PROMPT,
  DEFAULT_SUMMARY_EXAMPLES_PROMPT,
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
} from './src/ui.js';

configureMarked();

const state = {
  transcript: null,
  meta: null,
  history: [],
  settings: { ...DEFAULTS },
  busy: false,
  abortController: null,
};

// ----- settings -----

function activeProvider() {
  return getActiveProvider(state.settings);
}

// Merge unsaved form edits (API keys, baseUrl, temperature) into the
// persisted settings so refresh/test/ask see in-progress edits before
// the user presses Save. Each provider declares what it considers
// "form overrides" via its readFormOverrides() method.
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

// Settings that live outside any provider. Each tuple is
// [el ref key, settings key, DOM property to write].
const UI_BINDINGS = [
  ['uiFontSize', 'uiFontSize', 'value'],
  ['chatFontSize', 'chatFontSize', 'value'],
  ['transparentAssistant', 'transparentAssistant', 'checked'],
  ['summaryPrompt', 'summaryPrompt', 'value'],
  ['summaryExamplesPrompt', 'summaryExamplesPrompt', 'value'],
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
    const provider = activeProvider();
    const settings = effectiveSettings();
    collected = await streamChat({
      provider,
      settings,
      messages,
      model: provider.activeModel(settings),
      temperature: settings.temperature,
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

// Wire up every handler that a provider's form needs — radio change,
// Save, Test, Reload, optional Filter. Each provider declares its
// element ids via `ui.*`; this function touches no provider-specific
// fields and stays constant regardless of how many providers exist.
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
  await refreshAllProviders();

  const tab = await getActiveUdemyTab();
  if (!tab) {
    addMsg('system', 'Open a Udemy lecture and click ↻.');
  }
})();
