// Cluster inspector: click a topic label and this panel lists the memories in
// that cluster (filtered from the already-loaded atlas items), with each row
// expandable to its full text. Turns the map from a picture into a browsable,
// diagnosable index of what the agent actually remembers. Built with textConten
// (not innerHTML) since memory text is untrusted import data.

import { state } from './state.js';
import { loadChunk } from './data.js';

const CAP = 200; // rows rendered per cluster; the rest are summarized, not dropped
let panel = null;

export function openInspector(cluster) {
  panel = panel || document.getElementById('mb-inspector');
  if (!panel) return;
  const mems = state.items
    .filter((it) => it.cluster === cluster.id)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  panel.replaceChildren();

  const head = el('div', 'mbi-head');
  const title = el('div', 'mbi-title');
  title.textContent = cluster.label;
  title.style.color = `rgb(${cluster.color[0]},${cluster.color[1]},${cluster.color[2]})`;
  const sub = el('div', 'mbi-sub');
  sub.textContent = mems.length.toLocaleString() + ' memories';
  const close = el('button', 'mbi-close');
  close.textContent = '×';
  close.onclick = closeInspector;
  head.append(title, sub, close);
  panel.append(head);

  const list = el('div', 'mbi-list');
  for (const m of mems.slice(0, CAP)) {
    const row = el('div', 'mbi-row');
    const text = el('div', 'mbi-text');
    text.textContent = m.snippet;
    const meta = el('div', 'mbi-meta');
    meta.textContent = [m.source, m.date].filter(Boolean).join(' · ');
    row.append(text, meta);
    row.onclick = () => expandRow(row, m.id, text);
    list.append(row);
  }
  if (mems.length > CAP) {
    const more = el('div', 'mbi-more');
    more.textContent = '+' + (mems.length - CAP).toLocaleString() + ' more in this cluster';
    list.append(more);
  }
  panel.append(list);
  panel.style.display = '';
}

export function closeInspector() {
  if (panel) panel.style.display = 'none';
}

export function openLearningInspector(item, onAction) {
  panel = panel || document.getElementById('mb-inspector');
  if (!panel) return;
  panel.replaceChildren();

  const head = el('div', 'mbi-head');
  const title = el('div', 'mbi-title');
  title.textContent = item.name;
  const sub = el('div', 'mbi-sub');
  sub.textContent = [item.state, confidenceLabel(item.confidence)].filter(Boolean).join(' · ');
  const close = el('button', 'mbi-close');
  close.textContent = '×';
  close.onclick = closeInspector;
  head.append(title, sub, close);
  panel.append(head);

  appendDetailSection(panel, 'Evidence', item.evidence);
  appendDetailSection(panel, 'History', item.history);

  const versions = Array.isArray(item.versions) ? item.versions : [];
  const versionsSection = el('div', 'learned-inspector-section');
  const versionsLabel = el('div', 'learned-inspector-label');
  versionsLabel.textContent = 'Versions';
  versionsSection.append(versionsLabel);
  for (const version of versions) {
    const row = el('div', 'learned-inspector-version');
    const label = el('span');
    label.textContent = version.name || version.id || 'Version';
    row.append(label);
    if (version.id !== item.activeVersionId && item.state !== 'archived') {
      const rollback = el('button', 'learned-inspector-action');
      rollback.textContent = 'Roll back';
      rollback.onclick = () => onAction('rollback', version.id);
      row.append(rollback);
    }
    versionsSection.append(row);
  }
  if (!versions.length) {
    const empty = el('div', 'learned-inspector-copy');
    empty.textContent = 'No prior versions.';
    versionsSection.append(empty);
  }
  panel.append(versionsSection);
  panel.style.display = '';
}

function appendDetailSection(parent, label, value) {
  const section = el('div', 'learned-inspector-section');
  const heading = el('div', 'learned-inspector-label');
  heading.textContent = label;
  const copy = el('div', 'learned-inspector-copy');
  copy.textContent = detailText(value);
  section.append(heading, copy);
  parent.append(section);
}

function detailText(value) {
  if (Array.isArray(value)) return value.map((entry) => typeof entry === 'string' ? entry : JSON.stringify(entry)).join('\n');
  if (value && typeof value === 'object') return JSON.stringify(value, null, 2);
  return value ? String(value) : 'None recorded.';
}

function confidenceLabel(value) {
  return Number.isFinite(value) ? Math.round(value * 100) + '% confidence' : '';
}

async function expandRow(row, id, textEl) {
  if (row.dataset.expanded) {
    textEl.textContent = textEl.dataset.snippet;
    row.dataset.expanded = '';
    return;
  }
  textEl.dataset.snippet = textEl.textContent;
  textEl.textContent = 'Loading…';
  const c = await loadChunk(id);
  textEl.textContent = c && c.text ? c.text.trim() : textEl.dataset.snippet;
  row.dataset.expanded = '1';
}

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
