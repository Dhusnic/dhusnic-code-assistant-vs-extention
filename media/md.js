/* Tiny, XSS-safe markdown renderer. Everything is HTML-escaped before any tag is emitted. */
(function (root) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /** Only web and mail links are clickable: javascript:, data:, file: and command: URLs stay plain text. */
  const SAFE_URL = /^(https?:\/\/|mailto:)/i;
  const link = (href, text) => `<a href="${href}" class="ext-link" data-href="${href}" title="${href}">${text}</a>`;

  function inline(s) {
    // Code spans and links are set aside first, so emphasis markers inside a URL or code are never touched.
    const keep = [];
    const hold = (html) => `\u0000${keep.push(html) - 1}\u0000`;
    const emph = (x) => x
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
      .replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
    let t = esc(s).replace(/\u0000/g, '')
      .replace(/`([^`\n]+)`/g, (_, c) => hold(`<code>${c}</code>`))
      .replace(/\[([^\]\n]+)\]\(\s*([^\s)]+)(?:\s+&quot;[^&\n]*&quot;)?\s*\)/g, (m, text, href) => (SAFE_URL.test(href) ? hold(link(href, emph(text))) : m))
      .replace(/&lt;((?:https?:\/\/|mailto:)[^\s&]+)&gt;/gi, (_, href) => hold(link(href, href)))
      .replace(/(^|[\s(\u0000])((?:https?:\/\/)[^\s<\u0000]*[^\s<\u0000.,;:!?)\]'*_])/g, (_, pre, href) => `${pre}${hold(link(href, href))}`);
    t = emph(t);
    // Restored innermost-last: a link's text may itself hold a code span.
    for (let i = 0; i < 3 && t.includes('\u0000'); i++) { t = t.replace(/\u0000(\d+)\u0000/g, (_, n) => keep[Number(n)] ?? ''); }
    return t;
  }

  /* ---------- tables ---------- */
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l) || (/\|/.test(l) && /^\s*[^|\s].*\|.*[^|\s]\s*$/.test(l) && !/^\s*[-*>#]/.test(l));
  const isSep = (l) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l) && l.includes('-');
  function cells(l) {
    let t = l.trim();
    if (t.startsWith('|')) { t = t.slice(1); }
    if (t.endsWith('|') && !t.endsWith('\\|')) { t = t.slice(0, -1); }
    const out = []; let cur = ''; let inCode = false;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '`') { inCode = !inCode; cur += t[i]; }
      else if (t[i] === '\\' && t[i + 1] === '|') { cur += '|'; i++; }
      else if (t[i] === '|' && !inCode) { out.push(cur.trim()); cur = ''; }
      else { cur += t[i]; }
    }
    out.push(cur.trim());
    return out;
  }
  /** LLMs (and copy/paste) often put blank lines between table rows; join them back so the table survives. */
  function joinTableRows(lines) {
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      if (isRow(lines[i]) || isSep(lines[i])) {
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') { j++; }
        if (j > i + 1 && j < lines.length && (isRow(lines[j]) || isSep(lines[j]))) { i = j - 1; }
      }
    }
    return out;
  }
  function table(lines, start) {
    const head = cells(lines[start]);
    const align = cells(lines[start + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : /^:-+/.test(c) ? 'left' : ''));
    const rows = [];
    let i = start + 2;
    while (i < lines.length && isRow(lines[i]) && !isSep(lines[i])) { rows.push(cells(lines[i])); i++; }
    const td = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c ?? '')}</${tag}>`;
    const raw = lines.slice(start, i).join('\n');
    const html = `<div class="tablewrap" data-src="${esc(raw)}"><div class="tbar"><span>table · ${rows.length} row${rows.length === 1 ? '' : 's'}</span><button class="icon-btn" data-copy-table="md" title="Copy as Markdown">Copy</button><button class="icon-btn" data-copy-table="tsv" title="Copy as tab-separated values (pastes into Excel / Sheets)">Copy for Excel</button></div><table><thead><tr>${head.map((c, k) => td('th', c, k)).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, k) => td('td', r[k], k)).join('')}</tr>`).join('')}</tbody></table></div>`;
    return { html, next: i };
  }

  /* ---------- blocks ---------- */
  function codeBlock(lang, code, complete) {
    if (lang.toLowerCase() === 'mermaid') {
      return `<div class="mermaid-block" data-complete="${complete ? '1' : '0'}" data-src="${esc(code)}"><div class="bar"><span>mermaid</span><button class="icon-btn" data-copy>Copy</button></div><pre class="mermaid-src"><code>${esc(code)}</code></pre></div>`;
    }
    return `<div class="codeblock"><div class="bar"><span>${esc(lang || 'text')}</span><button class="icon-btn" data-copy>Copy</button></div><pre><code>${esc(code)}</code></pre></div>`;
  }

  function md(src) {
    const out = [];
    const parts = String(src).split(/(```[\s\S]*?(?:```|$))/g);
    for (const part of parts) {
      if (part.startsWith('```')) {
        const m = part.match(/^```([\w+-]*)[^\n]*\n?([\s\S]*?)(```)?$/);
        out.push(codeBlock(m[1] || '', m[2].replace(/\n$/, ''), !!m[3]));
        continue;
      }
      let list = null;
      const flush = () => { if (list) { out.push(`</${list}>`); list = null; } };
      const lines = joinTableRows(part.split('\n'));
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let m2;
        if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1]) && cells(lines[i + 1]).length === cells(line).length) { flush(); const t = table(lines, i); out.push(t.html); i = t.next - 1; }
        else if ((m2 = line.match(/^(#{1,6})\s+(.*)/))) { flush(); const n = Math.min(m2[1].length, 4); out.push(`<h${n}>${inline(m2[2])}</h${n}>`); }
        else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); }
        else if ((m2 = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)/))) { if (list !== 'ul') { flush(); out.push('<ul class="tasks">'); list = 'ul'; } out.push(`<li><input type="checkbox" disabled${m2[1] === ' ' ? '' : ' checked'}> ${inline(m2[2])}</li>`); }
        else if ((m2 = line.match(/^\s*[-*]\s+(.*)/))) { if (list !== 'ul') { flush(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m2[1])}</li>`); }
        else if ((m2 = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { flush(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m2[1])}</li>`); }
        else if ((m2 = line.match(/^>\s?(.*)/))) { flush(); out.push(`<blockquote>${inline(m2[1])}</blockquote>`); }
        else if (line.trim() === '') { flush(); }
        else { flush(); out.push(`<p>${inline(line)}</p>`); }
      }
      flush();
    }
    return out.join('');
  }

  /** Plain text (status messages, /sources) with its web addresses made clickable; nothing else is interpreted. */
  function autolink(s) {
    return esc(s).replace(/(^|[\s(\[])(https?:\/\/[^\s<]*[^\s<.,;:!?)\]'])/g, (_, pre, href) => `${pre}${link(href, href)}`);
  }

  const api = { md, inline, esc, autolink, cells, isRow, isSep };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; } else { root.InfraonMd = api; }
})(typeof window !== 'undefined' ? window : globalThis);
