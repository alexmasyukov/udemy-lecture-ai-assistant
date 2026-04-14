import {
  OPENAI_BASE,
  OPENROUTER_BASE,
  LOCAL_BASE_FALLBACK,
  OPENAI_FALLBACK_MODELS,
} from './defaults.js';
import { els, populateSelect } from './ui.js';

// Every provider is a self-contained object that declares:
//   - `ui`     — ids of the form elements it owns (matched against ID_MAP in ui.js)
//   - `fields` — keys on the persisted settings object it reads/writes
//   - LLM-side API: endpoint / buildBody / activeModel
//   - form API: applyToForm / collectFormPatch / readFormOverrides /
//               refresh / testCredentials / isConnected
//
// sidepanel.js does not know anything provider-specific — it iterates
// over `Object.values(providers)` and calls these methods.
// Adding a new provider means adding one object here + one <fieldset>
// in sidepanel.html + a few ids in ID_MAP.

const OPENROUTER_REFERER = 'https://github.com/alexmasyukov/udemy-lecture-ai-assistant';
const OPENROUTER_TITLE = 'Udemy Lecture AI';

function reasoningEffortFor(model) {
  if (/^gpt-5\.[1-9]/i.test(model)) return 'none';
  if (/^(gpt-5(-|$)|o1|o3|o4)/i.test(model)) return 'low';
  return null;
}

function isOpenaiChatModel(id) {
  if (!/^(gpt-|o1|o3|o4|chatgpt-)/i.test(id)) return false;
  if (/embed|whisper|tts|dall-e|moderation|audio|image|realtime|transcribe/i.test(id)) return false;
  return true;
}

export function normalizeBaseUrl(url) {
  return (url || '').trim().replace(/\/$/, '') || LOCAL_BASE_FALLBACK;
}

function setPlaceholder(selectEl, text) {
  selectEl.innerHTML = '';
  const opt = document.createElement('option');
  opt.textContent = text;
  opt.disabled = true;
  selectEl.appendChild(opt);
}

// -------------------------------------------------------------
// Local (LM Studio / any OpenAI-compatible endpoint)
// -------------------------------------------------------------

export const localProvider = {
  name: 'local',
  label: 'Local',
  ui: {
    radio: 'providerLocal',
    fieldset: 'localSettings',
    baseUrl: 'baseUrl',
    baseUrlTest: 'testBaseUrl',
    baseUrlResult: 'baseUrlResult',
    modelSelect: 'modelLocal',
    modelReload: 'reloadModels',
    temperature: 'temperature',
    save: 'saveLocal',
  },
  fields: {
    baseUrl: 'baseUrl',
    model: 'model',
    temperature: 'temperature',
  },
  cache: { models: [] },

  endpoint(settings) {
    return {
      base: normalizeBaseUrl(settings.baseUrl),
      headers: { 'Content-Type': 'application/json' },
    };
  },

  buildBody({ model, messages, temperature }) {
    return { model, messages, temperature, stream: true };
  },

  activeModel(settings) {
    return els.modelLocal.value || settings.model;
  },

  // What to merge into `settings` from the form before user presses Save
  // so refresh/test/ask see in-progress edits.
  readFormOverrides() {
    const patch = {};
    const baseUrl = els.baseUrl.value.trim();
    if (baseUrl) patch.baseUrl = baseUrl;
    const temp = parseFloat(els.temperature.value);
    if (!isNaN(temp)) patch.temperature = temp;
    return patch;
  },

  applyToForm(settings) {
    els.baseUrl.value = settings.baseUrl;
    els.temperature.value = settings.temperature;
  },

  collectFormPatch() {
    const patch = {
      baseUrl: els.baseUrl.value.trim() || LOCAL_BASE_FALLBACK,
      temperature: parseFloat(els.temperature.value) || 0.3,
    };
    if (els.modelLocal.value) patch.model = els.modelLocal.value;
    return patch;
  },

  async refresh(settings) {
    setPlaceholder(els.modelLocal, 'loading…');
    try {
      const { base } = this.endpoint(settings);
      const r = await fetch(`${base}/models`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const ids = (j.data || []).map((m) => m.id);
      this.cache.models = ids;
      populateSelect(els.modelLocal, ids, settings.model);
    } catch (e) {
      this.cache.models = [];
      setPlaceholder(els.modelLocal, `error: ${e.message}`);
    }
  },

  async testCredentials() {
    const base = normalizeBaseUrl(els.baseUrl.value);
    const r = await fetch(`${base}/models`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return (j.data || []).length;
  },

  isConnected() {
    return Boolean(els.modelLocal.value);
  },
};

// -------------------------------------------------------------
// OpenAI Cloud
// -------------------------------------------------------------

export const openaiProvider = {
  name: 'openai',
  label: 'OpenAI',
  ui: {
    radio: 'providerOpenai',
    fieldset: 'openaiSettings',
    apiKey: 'openaiApiKey',
    apiKeyTest: 'testOpenai',
    apiKeyResult: 'openaiResult',
    modelSelect: 'modelOpenai',
    modelReload: 'reloadOpenaiModels',
    save: 'saveOpenai',
  },
  fields: {
    apiKey: 'openaiApiKey',
    model: 'openaiModel',
  },
  cache: { models: [] },

  endpoint(settings) {
    return {
      base: OPENAI_BASE,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.openaiApiKey || ''}`,
      },
    };
  },

  buildBody({ model, messages }) {
    const body = { model, messages, stream: true };
    const effort = reasoningEffortFor(model);
    if (effort) body.reasoning_effort = effort;
    return body;
  },

  activeModel(settings) {
    return els.modelOpenai.value || settings.openaiModel;
  },

  readFormOverrides() {
    const key = els.openaiApiKey.value.trim();
    return key ? { openaiApiKey: key } : {};
  },

  applyToForm(settings) {
    els.openaiApiKey.value = settings.openaiApiKey || '';
  },

  collectFormPatch() {
    const patch = { openaiApiKey: els.openaiApiKey.value.trim() };
    if (els.modelOpenai.value) patch.openaiModel = els.modelOpenai.value;
    return patch;
  },

  async refresh(settings) {
    const key = settings.openaiApiKey;
    if (!key) {
      populateSelect(els.modelOpenai, OPENAI_FALLBACK_MODELS, settings.openaiModel);
      this.cache.models = OPENAI_FALLBACK_MODELS;
      return;
    }
    setPlaceholder(els.modelOpenai, 'loading…');
    try {
      const r = await fetch(`${OPENAI_BASE}/models`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const ids = (j.data || []).map((m) => m.id).filter(isOpenaiChatModel).sort();
      const list = ids.length ? ids : OPENAI_FALLBACK_MODELS;
      this.cache.models = list;
      populateSelect(els.modelOpenai, list, settings.openaiModel);
    } catch {
      this.cache.models = OPENAI_FALLBACK_MODELS;
      populateSelect(els.modelOpenai, OPENAI_FALLBACK_MODELS, settings.openaiModel);
    }
  },

  async testCredentials() {
    const key = els.openaiApiKey.value.trim();
    if (!key) throw new Error('enter API key first');
    const r = await fetch(`${OPENAI_BASE}/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return (j.data || []).length;
  },

  isConnected(settings) {
    const hasKey = Boolean(settings.openaiApiKey || els.openaiApiKey.value.trim());
    return hasKey && Boolean(els.modelOpenai.value);
  },
};

// -------------------------------------------------------------
// OpenRouter
// -------------------------------------------------------------

export const openrouterProvider = {
  name: 'openrouter',
  label: 'OpenRouter',
  ui: {
    radio: 'providerOpenrouter',
    fieldset: 'openrouterSettings',
    apiKey: 'openrouterApiKey',
    apiKeyTest: 'testOpenrouter',
    apiKeyResult: 'openrouterResult',
    modelSelect: 'modelOpenrouter',
    modelReload: 'reloadOpenrouterModels',
    filter: 'openrouterFilter',
    modelCount: 'openrouterModelCount',
    save: 'saveOpenrouter',
  },
  fields: {
    apiKey: 'openrouterApiKey',
    model: 'openrouterModel',
  },
  cache: { models: [] }, // [{ id, label, contextLength }]

  endpoint(settings) {
    return {
      base: OPENROUTER_BASE,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.openrouterApiKey || ''}`,
        'HTTP-Referer': OPENROUTER_REFERER,
        'X-Title': OPENROUTER_TITLE,
      },
    };
  },

  buildBody({ model, messages, temperature }) {
    // reasoning.effort = "none" globally disables thinking for every
    // reasoning-capable model (Claude thinking, DeepSeek R1, Gemini
    // Thinking, GPT-5, etc.). Non-reasoning models ignore it.
    return {
      model,
      messages,
      temperature,
      stream: true,
      reasoning: { effort: 'none' },
    };
  },

  activeModel(settings) {
    return els.modelOpenrouter.value || settings.openrouterModel;
  },

  readFormOverrides() {
    const key = els.openrouterApiKey.value.trim();
    return key ? { openrouterApiKey: key } : {};
  },

  applyToForm(settings) {
    els.openrouterApiKey.value = settings.openrouterApiKey || '';
  },

  collectFormPatch() {
    const patch = { openrouterApiKey: els.openrouterApiKey.value.trim() };
    if (els.modelOpenrouter.value) patch.openrouterModel = els.modelOpenrouter.value;
    return patch;
  },

  async refresh(settings) {
    setPlaceholder(els.modelOpenrouter, 'loading…');
    try {
      const headers = settings.openrouterApiKey
        ? { Authorization: `Bearer ${settings.openrouterApiKey}` }
        : {};
      const r = await fetch(`${OPENROUTER_BASE}/models`, { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      this.cache.models = (j.data || []).map((m) => ({
        id: m.id,
        label: m.name || m.id,
        contextLength: m.context_length || 0,
      }));
      this.renderSelect(settings);
    } catch (e) {
      this.cache.models = [];
      setPlaceholder(els.modelOpenrouter, `error: ${e.message}`);
      els.openrouterModelCount.textContent = '';
    }
  },

  renderSelect(settings) {
    const query = els.openrouterFilter.value.trim().toLowerCase();
    const words = query ? query.split(/\s+/) : [];
    const full = this.cache.models;
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
      opt.disabled = true;
      els.modelOpenrouter.appendChild(opt);
    } else {
      const selected = settings.openrouterModel;
      for (const m of filtered) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.label;
        if (m.id === selected) opt.selected = true;
        els.modelOpenrouter.appendChild(opt);
      }
      // Pin the saved model at the top as a ghost entry if the
      // filter would otherwise hide it.
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
  },

  onFilterInput(settings) {
    this.renderSelect(settings);
  },

  async testCredentials() {
    const key = els.openrouterApiKey.value.trim();
    if (!key) throw new Error('enter API key first');
    const { base, headers } = this.endpoint({ openrouterApiKey: key });
    const r = await fetch(`${base}/models`, { headers });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return (j.data || []).length;
  },

  isConnected(settings) {
    const hasKey = Boolean(settings.openrouterApiKey || els.openrouterApiKey.value.trim());
    return hasKey && Boolean(els.modelOpenrouter.value);
  },
};

// -------------------------------------------------------------

export const providers = {
  local: localProvider,
  openai: openaiProvider,
  openrouter: openrouterProvider,
};

export function getProvider(name) {
  return providers[name] || localProvider;
}

export function getActiveProvider(settings) {
  return getProvider(settings.provider);
}

// -------------------------------------------------------------
// Shared streaming pipeline — provider-agnostic.
// -------------------------------------------------------------

export async function streamChat({ provider, settings, messages, model, temperature, signal, onDelta }) {
  const { base, headers } = provider.endpoint(settings);
  const body = provider.buildBody({ model, messages, temperature });
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
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
  const handle = (raw) => {
    const line = raw.trim();
    if (!line.startsWith('data:')) return false;
    const data = line.slice(5).trim();
    if (data === '[DONE]') return true;
    try {
      const json = JSON.parse(data);
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) {
        content += delta;
        onDelta(content);
      }
    } catch {
      /* partial JSON — rare with line-based SSE */
    }
    return false;
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const raw of lines) {
      if (handle(raw) === true) return content;
    }
  }
  if (buffer && handle(buffer) === true) return content;
  return content;
}
