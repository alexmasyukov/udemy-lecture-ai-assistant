// Uses globals `marked` and `hljs` loaded via classic <script> tags
// before this module executes.

const TS_TOKEN = /\d{1,2}:\d{2}(?::\d{2})?/;
const TS_BLOCK = /\[(\s*\d{1,2}:\d{2}(?::\d{2})?(?:\s*[,\-–—]\s*\d{1,2}:\d{2}(?::\d{2})?)*\s*)\]/g;

export function tsToSeconds(ts) {
  const parts = ts.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return parts[0] * 60 + parts[1];
}

function wrapTs(ts) {
  return `<a href="#" class="ts-link" data-seek="${tsToSeconds(ts)}">${ts}</a>`;
}

export function linkifyTimestamps(html) {
  return html.replace(TS_BLOCK, (_, inner) => {
    const parts = inner.split(/(\s*[,\-–—]\s*)/);
    const rebuilt = parts
      .map((p) => (TS_TOKEN.test(p) && /^\d/.test(p) ? wrapTs(p) : p))
      .join('');
    return `[${rebuilt}]`;
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function configureMarked() {
  marked.setOptions({ gfm: true, breaks: true });
  const renderer = new marked.Renderer();
  renderer.code = function ({ text, lang }) {
    const language = lang && hljs.getLanguage(lang) ? lang : null;
    const highlighted = language
      ? hljs.highlight(text, { language }).value
      : hljs.highlightAuto(text).value;
    const cls = language ? ` class="language-${language}"` : '';
    return `<pre><code${cls}>${highlighted}</code></pre>`;
  };
  marked.setOptions({ renderer });
}

// Partial-stream safe: if marked throws on an in-flight chunk
// (rare, e.g. half-open code fence), fall back to escaped text
// so the assistant bubble never explodes mid-response.
export function renderMarkdown(text) {
  try {
    return linkifyTimestamps(marked.parse(text || ''));
  } catch {
    return linkifyTimestamps(escapeHtml(text || ''));
  }
}
