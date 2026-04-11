// Content script: extracts lecture ids from the Udemy DOM, calls the
// captions API to get the VTT URL list, downloads the chosen track and
// parses it. Falls back to scraping the on-page transcript panel if the
// API path fails.

const TRANSCRIPT_TOGGLE = '[data-purpose="transcript-toggle"]';
const TRANSCRIPT_PANEL = '[data-purpose="transcript-panel"]';
const TRANSCRIPT_CUE = '[data-purpose="transcript-cue"]';

// ----- meta from DOM -----

function readModuleArgs() {
  const el = document.querySelector('[data-module-args]');
  if (!el) return null;
  try {
    return JSON.parse(el.getAttribute('data-module-args'));
  } catch {
    return null;
  }
}

function currentLectureId() {
  const m = location.pathname.match(/\/lecture\/(\d+)/);
  return m ? m[1] : null;
}

function getLectureMeta() {
  const args = readModuleArgs() || {};
  const courseSlugMatch = location.pathname.match(/\/course\/([^/]+)\//);
  const titleEl =
    document.querySelector('[data-purpose="lecture-title"]') ||
    document.querySelector('.curriculum-item-link--curriculum-item-title-content--RVO2k');
  return {
    courseId: args.courseId ?? null,
    lectureId: args.initialCurriculumItemId ?? (Number(currentLectureId()) || null),
    courseSlug: courseSlugMatch ? courseSlugMatch[1] : null,
    lectureTitle: titleEl?.textContent?.trim() || document.title,
    url: location.href,
  };
}

// ----- captions API -----

async function fetchCaptionsList({ courseId, lectureId }) {
  if (!courseId || !lectureId) throw new Error('missing courseId/lectureId');
  const url = `https://www.udemy.com/api-2.0/users/me/subscribed-courses/${courseId}/lectures/${lectureId}/?fields[asset]=captions`;
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error(`captions API HTTP ${r.status}`);
  const json = await r.json();
  return json?.asset?.captions || [];
}

function pickCaption(captions, preferredLocale) {
  if (!captions.length) return null;
  if (preferredLocale) {
    const exact = captions.find((c) => c.locale_id === preferredLocale);
    if (exact) return exact;
  }
  // Prefer manual English, then any English, then any manual, then first.
  const manualEn = captions.find(
    (c) => c.source === 'manual' && /^en(_|$)/i.test(c.locale_id)
  );
  if (manualEn) return manualEn;
  const anyEn = captions.find((c) => /^en(_|$)/i.test(c.locale_id));
  if (anyEn) return anyEn;
  const manual = captions.find((c) => c.source === 'manual');
  return manual || captions[0];
}

// ----- VTT parsing -----

function parseVTT(vtt) {
  const lines = vtt.replace(/\r/g, '').split('\n');
  const cues = [];
  let i = 0;
  while (i < lines.length && !/-->/.test(lines[i])) i++;
  while (i < lines.length) {
    const line = lines[i];
    if (/-->/.test(line)) {
      const [a, b] = line.split('-->').map((s) => s.trim().split(' ')[0]);
      const start = tsToSeconds(a);
      const end = tsToSeconds(b);
      const textLines = [];
      i++;
      while (i < lines.length && lines[i].trim() !== '') {
        textLines.push(lines[i]);
        i++;
      }
      const text = textLines.join(' ').replace(/\s+/g, ' ').trim();
      if (text) cues.push({ start, end, text });
    }
    i++;
  }
  return cues;
}

function tsToSeconds(ts) {
  if (!ts) return 0;
  const parts = ts.split(':');
  let h = 0, m = 0, s = 0;
  if (parts.length === 3) [h, m, s] = parts;
  else if (parts.length === 2) [m, s] = parts;
  else [s] = parts;
  return Number(h) * 3600 + Number(m) * 60 + parseFloat(s);
}

function fmtTs(seconds) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

function cuesToTimestampedText(cues) {
  return cues.map((c) => `[${fmtTs(c.start)}] ${c.text}`).join('\n');
}
function cuesToPlainText(cues) {
  return cues.map((c) => c.text).join(' ');
}

// ----- transcript via API -----

async function getTranscriptViaApi(preferredLocale) {
  const meta = getLectureMeta();
  const captions = await fetchCaptionsList(meta);
  const captionList = captions.map((c) => ({
    locale_id: c.locale_id,
    label: c.video_label,
    source: c.source,
  }));
  const chosen = pickCaption(captions, preferredLocale);
  if (!chosen) return null;
  const r = await fetch(chosen.url, { credentials: 'omit' });
  if (!r.ok) throw new Error(`VTT HTTP ${r.status}`);
  const vtt = await r.text();
  const cues = parseVTT(vtt);
  if (!cues.length) return null;
  return {
    source: 'api',
    locale: chosen.locale_id,
    captionLabel: chosen.video_label,
    availableCaptions: captionList,
    cues,
    text: cuesToPlainText(cues),
    timestampedText: cuesToTimestampedText(cues),
  };
}

// ----- DOM fallback -----

function openTranscriptIfClosed() {
  if (document.querySelector(TRANSCRIPT_PANEL)) return;
  const btn = document.querySelector(TRANSCRIPT_TOGGLE);
  if (btn) btn.click();
}

async function getTranscriptViaDOM({ timeoutMs = 6000 } = {}) {
  openTranscriptIfClosed();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const cues = document.querySelectorAll(`${TRANSCRIPT_PANEL} ${TRANSCRIPT_CUE}`);
    if (cues.length) {
      const texts = [...cues].map((c) => c.textContent.trim()).filter(Boolean);
      return {
        source: 'dom',
        locale: null,
        captionLabel: null,
        availableCaptions: [],
        cues: texts.map((text) => ({ start: 0, end: 0, text })),
        text: texts.join(' '),
        timestampedText: texts.join('\n'),
      };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Transcript panel did not load in time');
}

async function getTranscript(preferredLocale) {
  try {
    const viaApi = await getTranscriptViaApi(preferredLocale);
    if (viaApi) return viaApi;
  } catch (e) {
    console.warn('[UdemyAI] API path failed, falling back to DOM:', e);
  }
  return getTranscriptViaDOM();
}

// ----- messaging -----

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'GET_TRANSCRIPT') {
    (async () => {
      try {
        const transcript = await getTranscript(msg.preferredLocale);
        sendResponse({ ok: true, transcript, meta: getLectureMeta() });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }
  if (msg?.type === 'GET_LECTURE_META') {
    sendResponse({ ok: true, meta: getLectureMeta() });
    return false;
  }
});
