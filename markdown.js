// Minimal Markdown → HTML renderer. Handles fenced/inline code, headers,
// bold/italic, links, ordered/unordered lists, paragraphs. Escapes HTML first
// so LLM output can't inject markup. Good enough for chat responses; not a
// full CommonMark implementation.

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function renderMarkdown(src) {
  if (!src) return '';

  const codeBlocks = [];
  src = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const i = codeBlocks.length;
    const cls = lang ? ` class="lang-${lang}"` : '';
    codeBlocks.push(`<pre><code${cls}>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000BLOCK${i}\u0000`;
  });

  const inlineCodes = [];
  src = src.replace(/`([^`\n]+)`/g, (_, code) => {
    const i = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000INLINE${i}\u0000`;
  });

  src = escapeHtml(src);

  src = src.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
  src = src.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
  src = src.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  src = src.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  src = src.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  src = src.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  src = src.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  src = src.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  src = src.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  const lines = src.split('\n');
  const out = [];
  let inUl = false;
  let inOl = false;
  const closeLists = () => {
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
  };
  for (const line of lines) {
    const ul = line.match(/^[-*] (.+)$/);
    const ol = line.match(/^\d+\. (.+)$/);
    if (ul) {
      if (inOl) { out.push('</ol>'); inOl = false; }
      if (!inUl) { out.push('<ul>'); inUl = true; }
      out.push(`<li>${ul[1]}</li>`);
    } else if (ol) {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (!inOl) { out.push('<ol>'); inOl = true; }
      out.push(`<li>${ol[1]}</li>`);
    } else {
      closeLists();
      out.push(line);
    }
  }
  closeLists();
  src = out.join('\n');

  src = src
    .split(/\n{2,}/)
    .map((chunk) => {
      const trimmed = chunk.trim();
      if (!trimmed) return '';
      if (/^<(h[1-6]|ul|ol|pre|blockquote|table)/.test(trimmed)) return trimmed;
      return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
    })
    .filter(Boolean)
    .join('\n');

  src = src.replace(/\u0000INLINE(\d+)\u0000/g, (_, i) => inlineCodes[+i]);
  src = src.replace(/\u0000BLOCK(\d+)\u0000/g, (_, i) => codeBlocks[+i]);

  return src;
}

window.renderMarkdown = renderMarkdown;
