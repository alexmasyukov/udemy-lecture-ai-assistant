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

// Wraps a transcript string saved on the backend into the same shape
// loadTranscript builds from a fresh content-script response, so the
// rest of the app (systemPrompt, persistSummary, info line) doesn't
// need to care where the transcript came from.
function transcriptFromMemory(text) {
  return {
    source: 'memory',
    locale: null,
    captionLabel: null,
    availableCaptions: [],
    cues: [],
    text,
    timestampedText: text,
  };
}

async function restoreFromMemory() {
  if (!state.settings.memoryEnabled) return;
  const key = lectureKey();
  if (!key) return;
  const history = await memory.listHistory(effectiveSettings(), key);
  // The backend returns summary regenerations as regular history rows
  // marked is_summary:true. We render them like any other assistant
  // message — chronological order, no special anchoring.
  for (const m of history) {
    const role = m.kind === 'q' ? 'user' : 'assistant';
    addMsg(role, m.content);
    state.history.push({ role, content: m.content });
  }
}

function postLectureInfo() {
  if (!state.transcript || !state.meta) return;
  const t = state.transcript;
  const localeStr = t.captionLabel ? ` · ${t.captionLabel}` : '';
  const title = state.meta.lectureTitle || 'Lecture';
  const cuesPart = t.cues?.length ? ` · ${t.cues.length} cues` : '';
  addMsg(
    'system',
    `${title} — ${t.source.toUpperCase()}${localeStr}${cuesPart} · ${t.text.length.toLocaleString()} chars · lecture ${state.meta.lectureId || '?'}`,
  );
}

// ----- transcript -----

// Fetches the transcript from the Udemy DOM/captions API and pushes
// it to the backend (creating the lection on first run). Used as the
// primary loader by the Reload button and as a fallback by openLecture
// when the backend has no saved transcript yet.
async function fetchFreshTranscript(tab) {
  const resp = await sendToTab(tab.id, { type: 'GET_TRANSCRIPT' });
  if (!resp?.ok) throw new Error(resp?.error || 'no response from content script');
  state.transcript = resp.transcript;
  state.meta = resp.meta;
  persistTranscript();
  return resp;
}

// Default open flow: prefers the backend's saved transcript and chat
// so the diff between what the lecture WAS when the user chatted vs.
// what Udemy serves NOW is preserved. Falls back to fetching from
// Udemy when the backend has nothing for this lecture (or memory is
// disabled / offline).
async function openLecture() {
  const tab = await getActiveUdemyTab();
  if (!tab) {
    addMsg('error', 'Open a Udemy lecture page first.');
    return;
  }

  state.transcript = null;
  state.meta = null;
  state.history = [];
  els.messages.innerHTML = '';

  els.loadTranscript.disabled = true;
  try {
    // Need the lecture meta first to look up the backend record.
    const metaResp = await sendToTab(tab.id, { type: 'GET_LECTURE_META' });
    if (!metaResp?.ok) throw new Error(metaResp?.error || 'no lecture meta');
    state.meta = metaResp.meta;

    let lection = null;
    if (state.settings.memoryEnabled) {
      const key = lectureKey();
      if (key) lection = await memory.getLectionByKey(effectiveSettings(), key);
    }

    if (lection?.transcript) {
      state.transcript = transcriptFromMemory(lection.transcript);
    } else {
      await fetchFreshTranscript(tab);
    }

    await restoreFromMemory();
    postLectureInfo();
    toggleBusy(false);
  } catch (e) {
    addMsg('error', `Could not open lecture: ${e.message}`);
  } finally {
    els.loadTranscript.disabled = false;
  }
}

// Force-refresh the transcript from Udemy, save the new version to the
// backend, and update state. Does NOT touch chat history or summary —
// the user may have a chat in progress they want to keep.
async function reloadTranscriptFromUdemy() {
  const tab = await getActiveUdemyTab();
  if (!tab) {
    addMsg('error', 'Open a Udemy lecture page first.');
    return;
  }
  els.loadTranscript.disabled = true;
  try {
    await fetchFreshTranscript(tab);
    addMsg('system', 'Transcript reloaded from Udemy.');
    postLectureInfo();
  } catch (e) {
    addMsg('error', `Could not reload transcript: ${e.message}`);
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
// Different from `ask`: doesn't show the prompt as a user message. The
// result is stored in /history with is_summary=true (same shape as a
// regular assistant turn). No /lections/upsert call here — transcript
// upserts only happen on lecture-open / Reload.
async function runSummary(prompt) {
  if (!state.transcript) {
    await openLecture();
    if (!state.transcript) return;
  }

  const pending = addMsg('assistant', '…');
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
        const atBottom =
          els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 40;
        setMsgContent(pending, content);
        if (atBottom) els.messages.scrollTop = els.messages.scrollHeight;
      },
    });
    setStatus('ok');
    if (!collected) {
      setMsgContent(pending, '(empty response)');
      return;
    }
    state.history.push({ role: 'assistant', content: collected });
    persistSummary(collected, model, eff);
  } catch (e) {
    if (e.name === 'AbortError') {
      if (collected) {
        state.history.push({ role: 'assistant', content: collected });
        persistSummary(collected, model, eff);
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
  }
}

function persistTranscript() {
  const key = lectureKey();
  if (!key || !state.settings.memoryEnabled) return;
  memory.upsertLection(effectiveSettings(), {
    ...key,
    title: state.meta?.lectureTitle || 'Lecture',
    url: state.meta?.url || null,
    transcript: state.transcript?.timestampedText || state.transcript?.text || null,
  });
}

function persistSummary(summary, model, eff) {
  const key = lectureKey();
  if (!key || !state.settings.memoryEnabled) return;
  memory.addMessage(eff, {
    ...key,
    kind: 'a',
    content: summary,
    model,
    is_summary: true,
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
  els.loadTranscript.addEventListener('click', reloadTranscriptFromUdemy);

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
    runSummary(state.settings.summaryExamplesPrompt || DEFAULT_SUMMARY_EXAMPLES_PROMPT);
  });
  els.summarizeExamples.addEventListener('click', (e) => {
    e.preventDefault();
    if (state.busy) return;
    closeMenu();
    runSummary(state.settings.summaryPrompt || DEFAULT_SUMMARY_PROMPT);
  });

  els.loadMemory.addEventListener('click', () => {
    if (state.busy) return;
    openLecture();
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
      openLecture();
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
    addMsg('system', 'Open a Udemy lecture to begin.');
  } else {
    openLecture();
  }
})();
