// Extensions the OS runs, or hands to an interpreter, when the file is opened.
// A chat link that opens one from this machine is labelled with the file's own
// name and a "program" badge (labelProgramLinks), never the agent's words, so a
// script cannot pass as a report. One list for every platform: a chat reads
// the same anywhere.
const PROGRAM_EXTENSIONS = new Set([
  'exe', 'com', 'scr', 'pif', 'cpl', 'msi', 'msp', 'msix', 'appx', 'bat', 'cmd', 'ps1', 'psm1',
  'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'lnk', 'url', 'reg',
  'msc', 'chm', 'ws', 'wsc', 'xll', 'application', 'appref-ms', 'inf', 'scf',
  'settingcontent-ms', 'library-ms', 'search-ms', 'diagcab', 'appinstaller',
  'app', 'command', 'tool', 'scpt', 'pkg', 'mpkg',
  'sh', 'bash', 'zsh', 'desktop', 'appimage', 'run', 'deb', 'rpm',
  'jar', 'py', 'pyw', 'pl', 'rb',
]);

// The decoded path a link points at, parsed the way the browser, the server and
// the desktop window-open handler parse it: the URL path, without query or
// fragment. The file-link click handler (shared-dom.js) opens this same path,
// so a label derived from it names the file the click opens.
function linkPath(href) {
  let path;
  try { path = new URL(href, 'http://localhost/').pathname; } catch { return ''; }
  try { return decodeURIComponent(path); } catch { return path; }
}

// The name of the program a link opens, or null. Read as Win32 reads a path,
// the opener that rewrites the most: ShellExecute stops at a NUL
// (`run.cmd%00.pdf` runs run.cmd) and drops trailing dots and spaces
// (`run.cmd.` runs run.cmd), and a `..` decoded from `%2F..` steps out of the
// segment before it.
function programLinkName(href) {
  const segments = [];
  for (const seg of linkPath(href).split('\0')[0].split(/[\\/]/)) {
    if (seg === '..') segments.pop();
    else if (seg && seg !== '.') segments.push(seg);
  }
  const name = (segments.pop() || '').replace(/[. ]+$/, '');
  const dot = name.lastIndexOf('.');
  return dot !== -1 && PROGRAM_EXTENSIONS.has(name.slice(dot + 1).toLowerCase()) ? name : null;
}

// A link to another site: an absolute http(s) URL off the app's own origin. It
// opens in a browser, which runs nothing, so a page named like a program
// (github.com/vercel/next.js) is still a page. Everything else, a /files/ or
// workspace link, a relative path, a file: URL, is something this machine may
// open.
function isWebLink(href) {
  let url;
  try { url = new URL(href); } catch { return false; } // relative: a path on the app's own origin
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== location.origin;
}

// Agent-built apps and workspace files are served from the agent origin, not
// this UI's (src/server/agent-origin.ts), so nothing they run can reach the
// shell. laxAgent holds where that is and the files-link capability: /files
// links carry it to this origin's /files redirect in place of the operator
// token. Fetched once at load; until it lands, /apps frames load through this
// origin's redirect and /files links get the capability only when clicked.
var laxAgent = { origin: '', filesLinkToken: '' };
const laxAgentReady = fetch('/api/agent-origin', { headers: { Authorization: 'Bearer ' + AUTH_TOKEN } })
  .then(r => (r.ok ? r.json() : null))
  .then(d => { if (d) laxAgent = d; })
  .catch(() => {});

// Where a frame showing agent content loads it, and whether the frame may keep
// the origin it lands on. /apps and /dashboards go straight to the agent
// origin; /files goes through this origin's redirect. A page this UI's origin
// would render keeps no origin at all (ownOrigin false), so it cannot reach the
// shell's DOM, storage or window.desktop. Only http(s): a javascript: src runs
// in the frame. Cache-busted so an agent's edits show on every load.
function agentFrameTarget(href) {
  let url;
  try { url = new URL(href, location.href); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.origin === location.origin && laxAgent.origin && /^\/(apps|dashboards)\//.test(url.pathname)) {
    url = new URL(url.pathname + url.search + url.hash, laxAgent.origin);
  }
  if (url.origin === location.origin && url.pathname.startsWith('/files/') && laxAgent.filesLinkToken) {
    url.searchParams.set('ft', laxAgent.filesLinkToken);
  }
  url.searchParams.set('_t', String(Date.now()));
  return { src: url.href, ownOrigin: url.origin !== location.origin };
}

// Every /files link this UI opens carries the files-link capability, never the
// operator token; the server trades it for a one-file signature on the agent
// origin. Only a path on this origin: an agent's absolute link may name another host.
function agentFilesHref(url) {
  const ft = laxAgent.filesLinkToken;
  if (!ft || !url.startsWith('/files/') || /[?&]ft=/.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + 'ft=' + ft;
}

// Relabels program links in sanitized markup. It reads each href from the
// parsed DOM, the value the click handler reads, so the label and the click
// cannot disagree. The badge
// sits inside the anchor, so opening the program stays one click. Format
// characters in the name are replaced: a right-to-left override would make
// `photo<RLO>gpj.cmd` show as `photodmc.jpg`.
function labelProgramLinks(html) {
  // md() runs on every streaming render, and most of them carry no link.
  if (!html.includes('<a')) return html;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  for (const a of tpl.content.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    const name = isWebLink(href) ? null : programLinkName(href);
    if (!name) continue;
    const badge = document.createElement('span');
    badge.className = 'link-program-badge';
    badge.setAttribute('style', 'display:inline-block;margin-left:4px;padding:0 6px;border-radius:8px;font-family:var(--mono);font-size:.62rem;font-weight:600;letter-spacing:.5px;text-transform:uppercase;vertical-align:middle;color:var(--warn);background:color-mix(in srgb, var(--warn) 10%, transparent);border:1px solid color-mix(in srgb, var(--warn) 40%, transparent)');
    badge.textContent = 'program';
    a.textContent = name.replace(/[\p{Cc}\p{Cf}]/gu, '\uFFFD');
    a.append(badge);
  }
  return tpl.innerHTML;
}

// Markdown renderer
function md(s) {
  if (!s) return '';

  // Placeholders for protected content
  const placeholders = [];
  function ph(html) { const i = placeholders.length; placeholders.push(html); return '\x00PH' + i + '\x00'; }

  // Every value md() puts in an attribute goes through attr(). Unescaped, a
  // quote in the agent's URL closes the attribute and adds the agent's own
  // style or class: an invisible program link stretched over the window. NUL
  // becomes U+FFFD, as the HTML parser would make it, so a placeholder sentinel
  // caught inside a URL is never restored as markup within the attribute.
  function attr(value) { return esc(value).replace(/\x00/g, '\uFFFD'); }
  // From step 3 on the text is escaped. Builders there decode it, so attr()
  // escapes the real value once.
  function unesc(html) { const d = document.createElement('div'); d.innerHTML = html; return d.textContent; }

  // A /files/ URL for a workspace-relative path. '#' is legal in a file name
  // (Invoice #42.docx) but starts a URL fragment, which would cut the name that
  // the click handler, the server and the desktop opener read; %23 keeps it.
  function filesUrl(rel) {
    return agentFilesHref('/files/' + rel.replace(/^\/+/, '').replace(/#/g, '%23'));
  }

  // Shared builder for workspace/report file links: 📄 + filename, routed
  // through the capability-gated /files/ route. The .file-download class is what
  // the global click handler (shared-dom.js) intercepts to open the file
  // natively in Electron; file-link is kept for existing CSS.
  const FILE_EXT = /\.(?:docx?|xlsx?|pptx?|pdf|csv|md|markdown|txt|json)$/i;
  function fileLink(escapedPath) {
    const clean = unesc(escapedPath).replace(/^\.\//, '').replace(/\\/g, '/');
    const ws = clean.match(/^workspace\/(.+)$/i);
    const fileName = clean.split('/').pop();
    return `<a href="${attr(filesUrl(ws ? ws[1] : clean))}" target="_blank" rel="noopener noreferrer" class="md-link file-link file-download">📄 ${esc(fileName)}</a>`;
  }

  let h = s;

  // 1. Extract code blocks first (protect from further processing).
  // Note: no inline onclick — sanitizeHtml() strips on*= attributes. Button
  // is wired via document-level delegation below (see code-copy-btn handler).
  h = h.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const langClass = lang ? ` class="language-${attr(lang)}"` : '';
    return ph(`<div class="code-block-wrapper"><div class="code-block-header"><span class="code-lang">${lang || 'code'}</span><button type="button" class="code-copy-btn" aria-label="Copy code">Copy</button></div><pre class="code-block"><code${langClass}>${esc(code)}</code></pre></div>`);
  });

  // 1.5. Extract LaTeX math (after code blocks so ``` wins, before links so
  // \frac{a}{b} etc. never hits the md regexes). Models emit \[..\] / $$..$$
  // for display math and \(..\) for inline. Single-$ is deliberately NOT a
  // delimiter — "$1.10 and $2" would false-positive on money. Rendered with
  // output:'html' (no MathML) because sanitizeHtml drops <math> subtrees;
  // KaTeX's HTML output is span/class/style only, which the allowlist keeps.
  // If katex failed to load (or the TeX is bad) fall back to escaped source.
  function texToHtml(tex, displayMode) {
    if (typeof katex === 'undefined') return null;
    try {
      return katex.renderToString(tex, { displayMode, output: 'html', throwOnError: false });
    } catch { return null; }
  }
  h = h.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (m, dollars, brackets) => {
    const rendered = texToHtml(dollars || brackets, true);
    return rendered === null ? m : ph(`<div class="md-math-block">${rendered}</div>`);
  });
  h = h.replace(/\\\(([\s\S]+?)\\\)/g, (m, tex) => {
    const rendered = texToHtml(tex, false);
    return rendered === null ? m : ph(rendered);
  });

  // 2. Extract inline images and links before escaping
  h = h.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
    const safeSrc = /^(https?:\/\/|data:image\/)/.test(src) ? src : '#';
    return ph(`<img src="${attr(safeSrc)}" alt="${attr(alt)}" class="inline-chat-img" onclick="openLightbox(this.src)" />`);
  });
  h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    // Strip trailing sentence punctuation that the agent (or markdown
    // emitter) may have included inside the parens by accident. Without
    // this, "open it here: [...](http://.../index.html.)" produces a link
    // whose href ends in `.` — server returns 404 because the route
    // doesn't match. Same hazard for .docx/.pptx/.pdf links generated by
    // file tools when the agent wraps them mid-sentence.
    let normalizedUrl = url.replace(/[.,;:!?]+$/, '');
    // file:///C:/Users/.../workspace/foo.docx → workspace/foo.docx
    const fileProtoMatch = normalizedUrl.match(/^file:\/\/\/.*?[/\\]workspace[/\\](.+)$/i);
    if (fileProtoMatch) normalizedUrl = 'workspace/' + fileProtoMatch[1].replace(/\\/g, '/');
    // C:\Users\...\workspace\foo.docx or /c/Users/.../workspace/foo.docx → workspace/foo.docx
    const absMatch = normalizedUrl.match(/^(?:[A-Za-z]:[/\\]|\/[a-z]\/).*?[/\\]workspace[/\\](.+)$/i);
    if (absMatch) normalizedUrl = 'workspace/' + absMatch[1].replace(/\\/g, '/');

    // Workspace-relative file links → serve via /files/ route
    const wsMatch = normalizedUrl.match(/^\.?\/?workspace\/(.+)$/);
    if (wsMatch) {
      return ph(`<a href="${attr(filesUrl(wsMatch[1]))}" target="_blank" rel="noopener noreferrer" class="md-link file-download">${esc(text)}</a>`);
    }
    // /files/ links (already resolved by LLM or tool output) → add the files-link capability
    if (/^\/files\/./.test(normalizedUrl)) {
      return ph(`<a href="${attr(agentFilesHref(normalizedUrl))}" class="md-link file-download">${esc(text)}</a>`);
    }
    // /videos/<file>  or  /images/<file>  (absolute or relative) — auth-gated
    // static routes. Add the auth token so the link works when clicked from
    // any context (Electron child window, regular browser tab, copy/paste).
    const mediaMatch = normalizedUrl.match(/^(?:https?:\/\/[^/]+)?(\/(?:videos|images)\/[A-Za-z0-9._-]+)(\?[^#]*)?$/);
    if (mediaMatch) {
      const token = AUTH_TOKEN || '';
      const path = mediaMatch[1];
      const existingQS = mediaMatch[2] || '';
      const sep = existingQS ? '&' : '?';
      const url = path + existingQS + (token ? sep + 'token=' + token : '');
      return ph(`<a href="${attr(url)}" target="_blank" rel="noopener noreferrer" class="md-link">${esc(text)}</a>`);
    }
    // Relative paths to document files → convert to /files/ route
    const docMatch = normalizedUrl.match(/^[^\/].*\.(docx?|xlsx?|pptx?|pdf|csv)$/i);
    if (docMatch) {
      return ph(`<a href="${attr(filesUrl(normalizedUrl.replace(/^\.\//, '')))}" class="md-link file-download">${esc(text)}</a>`);
    }
    const safeUrl = sanitizeUrl(normalizedUrl);
    return ph(`<a href="${attr(safeUrl)}" target="_blank" rel="noopener noreferrer" class="md-link">${esc(text)}</a>`);
  });

  // 2.5. Auto-linkify bare URLs (http/https). Grok in particular tends to
  // emit raw URLs without markdown brackets and trailing-punctuation patterns
  // ("see https://x.com.") that the legacy post-escape autolinker swallowed
  // into the href. Doing it BEFORE escape keeps the URL intact and lets us
  // strip trailing sentence punctuation cleanly. Image URLs are wrapped as
  // inline images, everything else as plain links. Stop at `)`, `]`, and `*`
  // so markdown-wrapped URLs (`[..](..)`, and crucially `**http://app/**` —
  // agents love bolding the app URL) don't get the closing emphasis markers
  // eaten into the href, which produced a 404'ing link ending in `**`.
  h = h.replace(/\b(https?:\/\/[^\s<>"'`)\]*]+)/g, (_, url) => {
    let trailing = '';
    const trimMatch = url.match(/[.,;:!?]+$/);
    if (trimMatch) { trailing = trimMatch[0]; url = url.slice(0, -trailing.length); }
    const safeUrl = sanitizeUrl(url);
    if (/\.(?:png|jpe?g|gif|webp|svg)(?:\?|#|$)/i.test(url)) {
      return ph(`<img src="${attr(safeUrl)}" alt="image" class="inline-chat-img" onclick="openLightbox(this.src)" />`) + trailing;
    }
    return ph(`<a href="${attr(safeUrl)}" target="_blank" rel="noopener noreferrer" class="md-link">${esc(url)}</a>`) + trailing;
  });

  // 3. Escape HTML
  h = esc(h);

  // 3.5. Auto-linkify bare workspace file paths (e.g., workspace/report.md)
  h = h.replace(/(?:^|\s)((?:\.\/)?workspace\/[^\s<>"]+\.(?:docx?|xlsx?|pptx?|pdf|csv|md|markdown|txt|json))/gi, (match, filePath) => {
    return match.replace(filePath, ph(fileLink(filePath)));
  });

  // 4. Inline formatting. A backtick-wrapped workspace path becomes a clickable
  // file link instead of plain code — agents report "written to
  // `workspace/foo.md`", and users expect to click straight through to open it.
  h = h.replace(/`([^`]+)`/g, (_, c) => {
    if (/^(?:\.\/)?workspace\/\S+/i.test(c) && FILE_EXT.test(c)) return ph(fileLink(c));
    return ph(`<code class="inline-code">${c}</code>`);
  });
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');
  h = h.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // 5. Horizontal rules
  h = h.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, '<hr style="border:none;border-top:1px solid var(--border);margin:12px 0">');

  // 6. Headers
  h = h.replace(/^#### (.+)$/gm, '<h5 class="md-h" style="font-size:.82rem">$1</h5>');
  h = h.replace(/^### (.+)$/gm, '<h4 class="md-h">$1</h4>');
  h = h.replace(/^## (.+)$/gm, '<h3 class="md-h">$1</h3>');
  h = h.replace(/^# (.+)$/gm, '<h2 class="md-h">$1</h2>');

  // 7. Blockquotes
  h = h.replace(/^&gt; (.+)$/gm, '<blockquote style="border-left:3px solid var(--accent-dim);padding-left:12px;margin:8px 0;color:var(--muted)">$1</blockquote>');

  // 8. Tables
  h = h.replace(/^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)+)/gm, (_, header, sep, body) => {
    const heads = header.split('|').filter(c => c.trim()).map(c => `<th style="padding:6px 10px;border-bottom:2px solid var(--border);text-align:left;font-size:.78rem">${c.trim()}</th>`).join('');
    const rows = body.trim().split('\n').map(row => {
      const cells = row.split('|').filter(c => c.trim()).map(c => `<td style="padding:5px 10px;border-bottom:1px solid var(--border);font-size:.78rem">${c.trim()}</td>`).join('');
      return `<tr>${cells}</tr>`;
    }).join('');
    return ph(`<table style="border-collapse:collapse;margin:8px 0;width:100%;font-family:var(--mono)"><thead><tr>${heads}</tr></thead><tbody>${rows}</tbody></table>`);
  });

  // 9. Lists — process line by line for proper grouping
  // Nesting: 2 spaces of indent = one level (models emit 2; tolerate 3-4 per
  // level via floor). A frame's <li> stays open until its next sibling or the
  // frame closes, so a deeper list nests INSIDE the item above it.
  const lines = h.split('\n');
  const result = [];
  const frames = []; // stack of {type:'ul'|'ol', liOpen:boolean}
  const LIST_STYLE = 'style="margin:4px 0;padding-left:20px"';
  function closeFrame() {
    const f = frames.pop();
    if (f.liOpen) result.push('</li>');
    result.push(`</${f.type}>`);
    // The parent's li (that this list nested inside) closes via its own flow.
  }
  function closeAllFrames() { while (frames.length) closeFrame(); }
  function itemHtml(content) {
    // Task-list items: "- [ ] foo" / "- [x] foo" → ☐/☑ (unicode, not
    // <input> — the sanitizer allowlist has no input tag).
    const task = content.match(/^\[( |x|X)\] (.+)$/);
    if (!task) return `<li>${content}`;
    const done = task[1].toLowerCase() === 'x';
    return `<li style="list-style:none;margin-left:-16px">${done ? '☑' : '☐'} ${done ? `<del>${task[2]}</del>` : task[2]}`;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ulMatch = line.match(/^(\s*)[-*] (.+)$/);
    const olMatch = line.match(/^(\s*)\d+\. (.+)$/);

    // Detect "1. **Bold header**" pattern — render as section header, not list item
    if (olMatch && olMatch[2].match(/^<strong>.+<\/strong>$/) && olMatch[1] === '') {
      closeAllFrames();
      result.push(`<h4 class="md-h" style="font-size:.88rem;margin-top:14px">${olMatch[2]}</h4>`);
    } else if (ulMatch || olMatch) {
      const m = ulMatch || olMatch;
      const type = ulMatch ? 'ul' : 'ol';
      const depth = Math.min(Math.floor(m[1].length / 2), 3);
      while (frames.length > depth + 1) closeFrame();
      if (frames.length === depth + 1 && frames[frames.length - 1].type !== type) closeFrame();
      while (frames.length < depth + 1) {
        result.push(`<${type} ${LIST_STYLE}>`);
        frames.push({ type, liOpen: false });
      }
      const f = frames[frames.length - 1];
      if (f.liOpen) result.push('</li>');
      result.push(itemHtml(m[2]));
      f.liOpen = true;
    } else if (line.trim() === '' && frames.length) {
      // Blank line inside a list: peek ahead. If the next non-blank line is
      // another list item, keep the list open so the renderer doesn't
      // close+reopen (which restarts <ol> numbering at 1).
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      const nextLine = j < lines.length ? lines[j] : '';
      if (/^(\s*)[-*] (.+)$/.test(nextLine) || /^(\s*)\d+\. (.+)$/.test(nextLine)) {
        continue; // swallow the blank, keep list open
      }
      closeAllFrames();
      result.push(line);
    } else {
      closeAllFrames();
      result.push(line);
    }
  }
  closeAllFrames();
  h = result.join('\n');

  // 10. Auto-link bare URLs
  h = h.replace(/(https?:\/\/[^\s<"']+\.(?:png|jpg|jpeg|gif|webp|svg))(\s|$)/gi, (_, url, after) => {
    return ph(`<img src="${attr(sanitizeUrl(unesc(url)))}" alt="image" class="inline-chat-img" onclick="openLightbox(this.src)" />`) + after;
  });
  h = h.replace(/(https?:\/\/[^\s<"'\x00*]+)/g, (match) => {
    return ph(`<a href="${attr(sanitizeUrl(unesc(match)))}" target="_blank" rel="noopener noreferrer" class="md-link">${match}</a>`);
  });

  // 11. Paragraphs — double newlines become paragraph breaks, single become <br>
  h = h.replace(/\n{2,}/g, '</p><p>');
  h = h.replace(/\n/g, '<br>');
  h = '<p>' + h + '</p>';
  // Clean up empty paragraphs and paragraphs wrapping block elements
  h = h.replace(/<p><\/p>/g, '');
  h = h.replace(/<p>(<(?:h[2-5]|ul|ol|table|div|blockquote|hr|pre))/g, '$1');
  h = h.replace(/(<\/(?:h[2-5]|ul|ol|table|div|blockquote|hr|pre)>)<\/p>/g, '$1');

  // 12. Restore placeholders — HIGHEST INDEX FIRST, because they nest.
  // Step 2.5 turns a bare URL into PH0; step 4 then finds that sentinel inside
  // backticks and wraps it in a code span of its own, PH1, whose CONTENT is the
  // text "\x00PH0\x00". Ascending, i=0 matched nothing (PH0 was not in the
  // document yet, only inside placeholder 1) and i=1 put it there after the
  // loop had passed — so the reader saw the literal "PH0" where the URL should
  // be. A placeholder can only ever contain sentinels created BEFORE it, so
  // descending restores every inner one before its own index comes up.
  // The placeholder is returned by a function, not passed as the replacement
  // string: there, a $` in the agent's URL would splice the document before it
  // into the href, whose quotes then close the attribute.
  for (let i = placeholders.length - 1; i >= 0; i--) {
    h = h.replace('\x00PH' + i + '\x00', () => placeholders[i]);
  }

  return labelProgramLinks(sanitizeHtml(h));
}
