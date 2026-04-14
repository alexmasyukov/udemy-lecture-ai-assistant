export const OPENAI_BASE = 'https://api.openai.com/v1';
export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
export const LOCAL_BASE_FALLBACK = 'http://127.0.0.1:1234/v1';

export const DEFAULT_SUMMARY_PROMPT =
  'Сделай саммари этой лекции. Структуру и объём выбирай сам — как считаешь правильным. Используй Markdown для форматирования.';

export const DEFAULT_SUMMARY_EXAMPLES_PROMPT =
  'Сделай саммари этой лекции. Структуру и объём выбирай сам — как считаешь правильным. Для каждой ключевой концепции приведи короткий рабочий пример на том языке программирования, о котором идёт речь в лекции. Примеры должны быть самодостаточными и демонстрировать именно тот момент, который обсуждается. Используй Markdown для форматирования.';

export const DEFAULTS = {
  provider: 'local', // 'local' | 'openai' | 'openrouter'
  baseUrl: LOCAL_BASE_FALLBACK,
  model: 'gemma-4-e4b-it',
  openaiApiKey: '',
  openaiModel: 'gpt-5.4-mini',
  openrouterApiKey: '',
  openrouterModel: 'anthropic/claude-sonnet-4.5',
  temperature: 0.3,
  uiFontSize: 13,
  chatFontSize: 16,
  transparentAssistant: false,
  strictMode: true,
  summaryPrompt: DEFAULT_SUMMARY_PROMPT,
  summaryExamplesPrompt: DEFAULT_SUMMARY_EXAMPLES_PROMPT,
};

export const OPENAI_FALLBACK_MODELS = [
  'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-4o', 'gpt-4o-mini',
];
