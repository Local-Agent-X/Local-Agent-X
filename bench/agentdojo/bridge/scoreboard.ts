// Live scoreboard. The orchestrator posts one verdict per episode; the bridge
// also tallies which gate blocked each denied tool call. Served as auto-refreshing
// HTML + JSON so the full sweep can be watched.
//
// AgentDojo metrics (polarity verified against InjectionTask.security(), which
// returns True when the attack SUCCEEDED):
//   ASR (attack success rate) = mean(attack succeeded)  — LOWER is better defense.
//   security / defended-rate  = 1 - ASR.
//   utility-under-attack      = task still completed while an injection was present.
//   benign utility            = task completed with no injection (sanity baseline).

interface Cell {
  attacked: number; attackedUtil: number; defended: number;
  benign: number; benignUtil: number;
  errors: number;
  blocks: Record<string, number>;
}

const cells = new Map<string, Cell>(); // key: `${config}|${suite}`
let startedAt = 0;

function cell(config: string, suite: string): Cell {
  const k = `${config}|${suite}`;
  let c = cells.get(k);
  if (!c) { c = { attacked: 0, attackedUtil: 0, defended: 0, benign: 0, benignUtil: 0, errors: 0, blocks: {} }; cells.set(k, c); }
  return c;
}

export function recordEpisode(p: {
  config: string; suite: string;
  utility_passed: boolean;
  security_passed: boolean | null; // True=defended, False=attack won, null=benign (no injection)
  errored?: boolean;
}): void {
  if (startedAt === 0) startedAt = Date.now();
  const c = cell(p.config, p.suite);
  if (p.errored) { c.errors++; return; }
  if (p.security_passed === null) {
    c.benign++; if (p.utility_passed) c.benignUtil++;
  } else {
    c.attacked++; if (p.utility_passed) c.attackedUtil++; if (p.security_passed) c.defended++;
  }
}

export function recordBlock(config: string, suite: string, stage: string): void {
  const c = cell(config, suite);
  c.blocks[stage] = (c.blocks[stage] || 0) + 1;
}

interface Row {
  config: string; suite: string; attacked: number;
  utilityAtk: number; benignUtil: number; asr: number; defended: number;
  errors: number; blocks: Record<string, number>;
}

function rowFrom(config: string, suite: string, c: Cell): Row {
  return {
    config, suite, attacked: c.attacked,
    utilityAtk: c.attacked ? c.attackedUtil / c.attacked : 0,
    benignUtil: c.benign ? c.benignUtil / c.benign : 0,
    asr: c.attacked ? 1 - c.defended / c.attacked : 0,
    defended: c.attacked ? c.defended / c.attacked : 1,
    errors: c.errors, blocks: c.blocks,
  };
}

export function snapshot() {
  const rows: Row[] = [];
  const agg = new Map<string, Cell>();
  for (const [k, c] of cells) {
    const [config, suite] = k.split("|");
    rows.push(rowFrom(config, suite, c));
    let a = agg.get(config);
    if (!a) { a = { attacked: 0, attackedUtil: 0, defended: 0, benign: 0, benignUtil: 0, errors: 0, blocks: {} }; agg.set(config, a); }
    a.attacked += c.attacked; a.attackedUtil += c.attackedUtil; a.defended += c.defended;
    a.benign += c.benign; a.benignUtil += c.benignUtil; a.errors += c.errors;
    for (const [s, n] of Object.entries(c.blocks)) a.blocks[s] = (a.blocks[s] || 0) + n;
  }
  rows.sort((a, b) => a.config.localeCompare(b.config) || a.suite.localeCompare(b.suite));
  const totals = [...agg.entries()].map(([config, c]) => rowFrom(config, "ALL", c)).sort((a, b) => a.config.localeCompare(b.config));
  return { startedAt, elapsedSec: startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0, totals, rows };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const blocksStr = (b: Record<string, number>) =>
  Object.entries(b).sort((a, c) => c[1] - a[1]).map(([k, n]) => `${k}:${n}`).join("  ") || "—";

function tr(r: Row, cls = ""): string {
  return `<tr class="${cls}"><td>${r.config}</td><td>${r.suite}</td><td>${r.attacked}</td>
    <td>${pct(r.utilityAtk)}</td><td>${pct(r.benignUtil)}</td>
    <td class="asr">${pct(r.asr)}</td><td class="sec">${pct(r.defended)}</td>
    <td>${r.errors}</td><td class="bl">${blocksStr(r.blocks)}</td></tr>`;
}

export function renderHtml(): string {
  const s = snapshot();
  const head = `<tr><th>config</th><th>suite</th><th>attacked</th><th>utility (atk)</th><th>utility (benign)</th>
    <th>ASR ↓</th><th>defended ↑</th><th>err</th><th>blocks by stage</th></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>ARI × AgentDojo — live</title>
  <meta http-equiv="refresh" content="5"><style>
    body{font:14px/1.5 -apple-system,Segoe UI,sans-serif;margin:24px;color:#111}
    h1{font-size:18px} .meta{color:#666;margin-bottom:16px}
    table{border-collapse:collapse;width:100%;margin-bottom:24px}
    th,td{border:1px solid #ddd;padding:6px 10px;text-align:left}
    th{background:#f5f5f5} .agg{background:#fbfbe8;font-weight:600}
    .asr{color:#b3261e;font-weight:600} .sec{color:#0a7d28} .bl{color:#555;font-size:12px}
    caption{text-align:left;font-weight:600;margin:8px 0}
  </style></head><body>
  <h1>ARI Kernel × AgentDojo — live</h1>
  <div class="meta">elapsed ${s.elapsedSec}s · auto-refresh 5s · ASR = attack success rate (lower = better defense) · attack=important_instructions</div>
  <table><caption>Per-config (all suites)</caption>${head}${s.totals.map((r) => tr(r, "agg")).join("")}</table>
  <table><caption>Per-suite detail</caption>${head}${s.rows.map((r) => tr(r)).join("")}</table>
  </body></html>`;
}
