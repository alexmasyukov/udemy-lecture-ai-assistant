import { renderMarkdown } from './markdown.js';

const ID_MAP = {
  statusDot: 'status-dot',
  statusLabel: 'status-label',
  settingsToggle: 'settings-toggle',
  settingsPanel: 'settings-panel',
  providerLocal: 'provider-local',
  providerOpenai: 'provider-openai',
  providerOpenrouter: 'provider-openrouter',
  localSettings: 'local-settings',
  openaiSettings: 'openai-settings',
  openrouterSettings: 'openrouter-settings',
  baseUrl: 'baseUrl',
  testBaseUrl: 'test-base-url',
  baseUrlResult: 'base-url-result',
  openaiApiKey: 'openaiApiKey',
  testOpenai: 'test-openai',
  openaiResult: 'openai-result',
  openrouterApiKey: 'openrouterApiKey',
  testOpenrouter: 'test-openrouter',
  openrouterResult: 'openrouter-result',
  openrouterFilter: 'openrouter-filter',
  openrouterModelCount: 'openrouter-model-count',
  modelLocal: 'model-local',
  modelOpenai: 'model-openai',
  modelOpenrouter: 'model-openrouter',
  reloadModels: 'reload-models',
  reloadOpenaiModels: 'reload-openai-models',
  reloadOpenrouterModels: 'reload-openrouter-models',
  saveOpenrouter: 'save-openrouter',
  temperature: 'temperature',
  uiFontSize: 'uiFontSize',
  chatFontSize: 'chatFontSize',
  transparentAssistant: 'transparentAssistant',
  saveLocal: 'save-local',
  saveOpenai: 'save-openai',
  saveUi: 'save-ui',
  summaryPrompt: 'summaryPrompt',
  summaryExamplesPrompt: 'summaryExamplesPrompt',
  savePrompts: 'save-prompts',
  resetPrompts: 'reset-prompts',
  loadTranscript: 'load-transcript',
  summarize: 'summarize',
  summarizeExamples: 'summarize-examples',
  clearChat: 'clear-chat',
  menuToggle: 'menu-toggle',
  menu: 'menu',
  stopBtn: 'stop-btn',
  strictMode: 'strict-mode',
  messages: 'messages',
  askForm: 'ask-form',
  askInput: 'ask-input',
  askBtn: 'ask-btn',
};

export const els = Object.fromEntries(
  Object.entries(ID_MAP).map(([key, id]) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`UI element not found: #${id}`);
    return [key, el];
  })
);

export function setMsgContent(div, text) {
  if (div.classList.contains('assistant')) {
    div.innerHTML = renderMarkdown(text);
  } else {
    div.textContent = text;
  }
}

export function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  setMsgContent(div, text);
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  return div;
}

export function setStatus(kind) {
  els.statusDot.classList.remove('ok', 'err');
  if (kind) els.statusDot.classList.add(kind);
  els.statusLabel.textContent =
    kind === 'ok' ? 'LLM connected' : kind === 'err' ? 'LLM offline' : 'LLM…';
}

export function setBusy(busy) {
  els.askBtn.classList.toggle('hidden', busy);
  els.stopBtn.classList.toggle('hidden', !busy);
  els.summarize.disabled = busy;
  els.summarizeExamples.classList.toggle('disabled', busy);
}

export function applyFontSizes({ uiFontSize, chatFontSize }) {
  document.documentElement.style.setProperty('--ui-font', `${uiFontSize}px`);
  document.documentElement.style.setProperty('--chat-font', `${chatFontSize}px`);
}

export function applyAppearance({ transparentAssistant }) {
  document.body.classList.toggle('transparent-assistant', Boolean(transparentAssistant));
}

export function autoresizeInput() {
  els.askInput.style.height = 'auto';
  els.askInput.style.height = `${els.askInput.scrollHeight}px`;
}

export function setInlineResult(el, text, kind) {
  el.textContent = text;
  el.style.color =
    kind === 'ok' ? 'var(--ok)' : kind === 'err' ? 'var(--err)' : 'var(--muted)';
}

export function populateSelect(selectEl, ids, selected) {
  selectEl.innerHTML = '';
  if (!ids.length) {
    const opt = document.createElement('option');
    opt.textContent = 'no models available';
    opt.disabled = true;
    selectEl.appendChild(opt);
    return;
  }
  for (const id of ids) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id;
    if (id === selected) opt.selected = true;
    selectEl.appendChild(opt);
  }
}
