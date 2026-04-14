const UDEMY_LECTURE_RE = /udemy\.com\/course\/.*\/learn\/lecture\//;

export async function getActiveUdemyTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !UDEMY_LECTURE_RE.test(tab.url)) return null;
  return tab;
}

// If the content script has not been injected into the tab yet (happens
// for tabs that were already open when the extension was installed, or
// occasionally after SPA navigation), reinject it on demand.
export async function sendToTab(tabId, message) {
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

export function buildSystemPrompt({ transcript, meta, strictMode }) {
  const hasTranscript = Boolean(transcript);
  const hasTimestamps = transcript?.source === 'api';
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
  const modeLines = strictMode
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
    `Название лекции: ${meta?.lectureTitle || 'Неизвестно'}`,
    '',
    '--- НАЧАЛО ТРАНСКРИПТА ---',
    transcript.timestampedText || transcript.text || '(empty)',
    '--- КОНЕЦ ТРАНСКРИПТА ---',
  ]
    .filter(Boolean)
    .join('\n');
}
