import { OPENAI_BASE, OPENROUTER_BASE, LOCAL_BASE_FALLBACK } from './defaults.js';

const OPENROUTER_REFERER = 'https://github.com/alexmasyukov/udemy-lecture-ai-assistant';
const OPENROUTER_TITLE = 'Udemy Lecture AI';

function reasoningEffortFor(model) {
  // gpt-5.1, 5.2, 5.3, 5.4… accept full disable
  if (/^gpt-5\.[1-9]/i.test(model)) return 'none';
  // gpt-5 / o1 / o3 / o4 need at least "low"
  if (/^(gpt-5(-|$)|o1|o3|o4)/i.test(model)) return 'low';
  // gpt-4o, chatgpt-*, gpt-4 reject the parameter
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

export const localProvider = {
  name: 'local',
  endpoint(settings) {
    return {
      base: normalizeBaseUrl(settings.baseUrl),
      headers: { 'Content-Type': 'application/json' },
    };
  },
  buildBody({ model, messages, temperature }) {
    return { model, messages, temperature, stream: true };
  },
  async listModels(settings) {
    const { base } = this.endpoint(settings);
    const r = await fetch(`${base}/models`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return (j.data || []).map((m) => m.id);
  },
  activeModel(settings) {
    return settings.model;
  },
};

export const openaiProvider = {
  name: 'openai',
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
  async listModels(settings) {
    if (!settings.openaiApiKey) return [];
    const r = await fetch(`${OPENAI_BASE}/models`, {
      headers: { Authorization: `Bearer ${settings.openaiApiKey}` },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return (j.data || []).map((m) => m.id).filter(isOpenaiChatModel).sort();
  },
  activeModel(settings) {
    return settings.openaiModel;
  },
};

export const openrouterProvider = {
  name: 'openrouter',
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
    // reasoning.effort = "none" disables thinking for every reasoning-capable
    // model (Claude thinking, DeepSeek R1, Gemini Thinking, GPT-5, etc.).
    // Non-reasoning models ignore it.
    return {
      model,
      messages,
      temperature,
      stream: true,
      reasoning: { effort: 'none' },
    };
  },
  async listModels(settings) {
    // Public endpoint — no key needed, but send it if we have one so
    // routed variants (paid/free) stay consistent.
    const headers = settings.openrouterApiKey
      ? { Authorization: `Bearer ${settings.openrouterApiKey}` }
      : {};
    const r = await fetch(`${OPENROUTER_BASE}/models`, { headers });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return (j.data || []).map((m) => ({
      id: m.id,
      label: m.name || m.id,
      contextLength: m.context_length || 0,
    }));
  },
  activeModel(settings) {
    return settings.openrouterModel;
  },
};

export const providers = {
  local: localProvider,
  openai: openaiProvider,
  openrouter: openrouterProvider,
};

export function getProvider(settings) {
  return providers[settings.provider] || localProvider;
}

export async function testEndpoint({ base, headers }) {
  const r = await fetch(`${normalizeBaseUrl(base)}/models`, { headers });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return (j.data || []).length;
}

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
      /* partial JSON — extremely rare with line-based SSE */
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
