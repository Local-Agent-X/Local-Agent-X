#!/usr/bin/env node
/**
 * Plug-and-play conformance gate for the integration registry.
 *
 * The product promise is: user saves a credential in Settings, the capability
 * appears, and it works no matter which model is driving (Grok, Ollama, GPT,
 * Claude). ~100 tools cannot be hand-tested one at a time, so this audits the
 * DECLARATIONS over the whole registry in one pass — the same move as the
 * user-owned-controls contract test (d0bb7247).
 *
 * Four failure classes, all statically decidable:
 *
 *   steer:<tool>      tool description steers at a model-locked path. A tool
 *                     that says "use the Gmail MCP tool instead" is dead advice
 *                     on every non-Anthropic model, and actively suppresses the
 *                     portable tool the user actually configured.
 *   authtype:<id>     declared authType cannot carry the declared endpoints. An
 *                     api_key identifies a PROJECT, not a user — so it can never
 *                     satisfy a user-scoped path (/users/me, /me, primary).
 *                     Those endpoints 403 forever, no matter the model.
 *   transport:<id>    the integration is shaped like an HTTP API (baseUrl +
 *                     endpoints consumed by http_request) but its endpoints
 *                     aren't HTTP paths, or it has no baseUrl to join them to.
 *                     An integration that DECLARES a non-HTTP transport is
 *                     exempt from that shape — it is not a broken HTTP API, it
 *                     is correctly saying it is not an HTTP API at all — but is
 *                     held to the coherence its own declaration implies.
 *   secret:<id>       the credentials the runtime resolves don't match the
 *                     credentials the install path can store — so Settings
 *                     reports CONNECTED while the capability stays dead.
 *   runtime:<id>      no runtime path at all: not reachable via http_request,
 *                     no dedicated tool family. Phantom capability.
 *
 * Parses source text (no imports) so it is fast and side-effect-free — same
 * shape as check-pricing-coverage.mjs. Run via `npm run check:integrations`.
 *
 * Known-violation baseline lives in scripts/integration-conformance-baseline.json.
 * It exists so the gate can land on a repo that already has violations without
 * flipping the build red on day one (same convention as check-source-hygiene's
 * GRANDFATHERED list). It is a RATCHET, not a mute: every baselined finding is
 * printed on every run, and a baseline entry that no longer reproduces FAILS the
 * build so the list can only shrink.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const BUILTINS_DIR = join(root, "src/integrations/builtins");
const BASELINE_PATH = join(root, "scripts/integration-conformance-baseline.json");

const findings = [];
const add = (id, file, detail) => findings.push({ id, file, detail });

// ---------------------------------------------------------------- source scan

const isSource = (n) => n.endsWith(".ts") && !n.endsWith(".d.ts") && !n.endsWith(".test.ts");

function walk(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (isSource(name)) out.push(p);
  }
  return out;
}

const sourceFiles = walk(join(root, "src"));
const rel = (p) => relative(root, p).split("\\").join("/");

/** Read one or more `+`-concatenated string literals starting at `i`. */
function readConcatString(text, i) {
  let out = "";
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    const quote = text[i];
    if (quote !== '"' && quote !== "'" && quote !== "`") return out || null;
    i++;
    let buf = "";
    while (i < text.length && text[i] !== quote) {
      if (text[i] === "\\") { buf += text[i + 1] === "n" ? " " : text[i + 1]; i += 2; continue; }
      buf += text[i++];
    }
    i++; // closing quote
    out += buf;
    const save = i;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== "+") { i = save; return out; }
    i++;
  }
}

const lineOf = (text, idx) => text.slice(0, idx).split("\n").length;

// ------------------------------------------------- CHECK 1: model-locked steer

// Phrases that bind a tool's advice to one vendor's runtime. The MCP connector
// names are the confirmed offenders; the rest are the same failure shape.
// Each pattern requires a ROUTING cue ("use X instead", "when connected"), not
// a bare vendor name — a tool that merely *names* a vendor is fine (memory_ingest
// legitimately lists ChatGPT/Claude.ai/Codex as supported import formats). What
// breaks portability is a description that sends the model somewhere else.
const STEERS = [
  /\b(gmail|google calendar|google drive)\s+mcp\b/i,
  /\bmcp (tool|server|connector)\b[^.]{0,40}\b(instead|when connected|if connected)\b/i,
  /\buse the\b[^.]{0,40}\bmcp\b[^.]{0,30}\b(instead|when connected)\b/i,
  /\b(use|prefer|switch to|route to)\b[^.]{0,60}\b(claude\.ai|chatgpt|copilot)\b[^.]{0,60}\b(connector|integration|tool)\b/i,
  /\bwhen (you are|you're|using) (claude|chatgpt|gpt|gemini|grok)\b/i,
  /\bif (you are|you're) (claude|chatgpt|gpt|gemini|grok)\b/i,
];

for (const file of sourceFiles) {
  const text = readFileSync(file, "utf8");
  // Attribute each `description:` to the nearest preceding `name: "<snake>"`,
  // which is the ToolDefinition shape used across src/tools.
  for (const m of text.matchAll(/\bname:\s*["']([a-z][a-z0-9_]*)["']/g)) {
    const toolName = m[1];
    const after = text.slice(m.index, m.index + 4000);
    const d = after.match(/\bdescription:\s*/);
    if (!d) continue;
    // Only take a description that belongs to this object (no intervening name:).
    const between = after.slice(0, d.index);
    if (/\bname:\s*["']/.test(between.slice(m[0].length))) continue;
    const desc = readConcatString(text, m.index + d.index + d[0].length);
    if (!desc) continue;
    for (const re of STEERS) {
      if (re.test(desc)) {
        const snippet = desc.match(new RegExp(`.{0,60}${re.source}.{0,60}`, "i"))?.[0] ?? desc.slice(0, 120);
        add(`steer:${toolName}`, `${rel(file)}:${lineOf(text, m.index)}`, `"…${snippet.trim()}…"`);
        break;
      }
    }
  }
}

// -------------------------------------------------- integration declarations

const field = (text, key) => {
  const m = text.match(new RegExp(`\\b${key}:\\s*`));
  return m ? readConcatString(text, m.index + m[0].length) : null;
};

/**
 * Names declared in the integration's `credentials: [...]` list, in order.
 * Scoped to the bracketed list so the `name:` keys inside `endpoints` cannot
 * leak in. Index 0 is the primary — the one entry the install path persists.
 */
function credentialNames(text) {
  const m = text.match(/\bcredentials:\s*\[/);
  if (!m) return [];
  let i = m.index + m[0].length;
  let depth = 1;
  for (; i < text.length && depth > 0; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]") depth--;
  }
  const block = text.slice(m.index, i);
  return [...block.matchAll(/\bname:\s*["']([^"']+)["']/g)].map((n) => n[1]);
}

/**
 * The non-HTTP transports this build knows, read out of TRANSPORT_TOOLS in
 * src/integrations/types.ts rather than re-listed here. A second list would
 * drift, and the drift would be silent in exactly the direction that matters:
 * a transport the code honours but this gate does not would be reported as a
 * broken HTTP API forever (which is the bug this check just had).
 */
const TYPES_TEXT = readFileSync(join(root, "src/integrations/types.ts"), "utf8");
const TRANSPORT_BLOCK = TYPES_TEXT.match(/TRANSPORT_TOOLS[^=]*=\s*\{([\s\S]*?)\n\};/);
const NON_HTTP_TRANSPORTS = new Set(
  [...(TRANSPORT_BLOCK?.[1] ?? "").matchAll(/^\s*(\w+)\s*:/gm)].map((m) => m[1]),
);
if (NON_HTTP_TRANSPORTS.size === 0) {
  console.error("check-integration-conformance: FAIL — parsed 0 non-HTTP transports from src/integrations/types.ts (shape changed? update this script).");
  process.exit(1);
}

const integrations = [];
for (const name of readdirSync(BUILTINS_DIR)) {
  if (name === "index.ts" || !isSource(name)) continue;
  const file = join(BUILTINS_DIR, name);
  const text = readFileSync(file, "utf8");
  const endpoints = [];
  for (const m of text.matchAll(/\{\s*name:\s*["'][^"']*["'],\s*method:\s*["'](\w+)["'],\s*path:\s*["']([^"']*)["']/g)) {
    endpoints.push({ method: m[1], path: m[2] });
  }
  integrations.push({
    file: rel(file),
    id: field(text, "id"),
    authType: field(text, "authType"),
    baseUrl: field(text, "baseUrl") ?? "",
    transport: field(text, "transport") ?? "http",
    credentials: credentialNames(text),
    authInstructions: field(text, "authInstructions") ?? "",
    endpoints,
  });
}

// Cross-check against BUILTIN_INTEGRATIONS so a new builtin that lives outside
// this directory (or is declared and never registered) can't slip the audit.
const indexText = readFileSync(join(BUILTINS_DIR, "index.ts"), "utf8");
const registered = [...indexText.matchAll(/^\s*(\w+Integration),$/gm)].map((m) => m[1]);
if (registered.length !== integrations.length) {
  console.error(
    `check-integration-conformance: FAIL — BUILTIN_INTEGRATIONS registers ${registered.length} integrations but ${integrations.length} declaration files were parsed. Update this script if the registry shape changed.`,
  );
  process.exit(1);
}
if (integrations.length === 0) {
  console.error("check-integration-conformance: FAIL — parsed 0 integrations (shape changed? update this script).");
  process.exit(1);
}

// ----------------------------------------- CHECK 2: authType vs endpoint scope

// An api_key authenticates the CALLING PROJECT. Any endpoint addressing "the
// signed-in user" therefore cannot be satisfied by it — it needs a user-context
// OAuth2 token. These paths are the giveaway.
const USER_SCOPED = [
  /\/users\/me(\/|$)/,
  /\/users\/@me(\/|$)/,
  /\/@me(\/|$)/,
  /\/me(\/|$)/,
  /\/user(s)?(\/|$)/,
  /\/calendars\/primary(\/|$)/,
  /\/drive\/v\d+\/files(\/|$)/,
];

for (const i of integrations) {
  if (i.authType !== "api_key") continue;
  const bad = i.endpoints.filter((e) => USER_SCOPED.some((re) => re.test(e.path)));
  if (bad.length > 0) {
    add(
      `authtype:${i.id}`,
      i.file,
      `authType "api_key" cannot satisfy ${bad.length}/${i.endpoints.length} user-scoped endpoint(s) — needs OAuth2 user context: ${bad.map((e) => `${e.method} ${e.path}`).join(", ")}`,
    );
  }
}

// ------------------------------------------------- CHECK 3: transport coherence

for (const i of integrations) {
  // An integration that DECLARES a non-HTTP transport is not "shaped like a
  // broken HTTP API" — it is saying, in the one place the runtime reads, that
  // http_request is not its runtime path. The empty baseUrl and the pseudo-paths
  // are then the CORRECT shape, not the defect: getAgentContext() renders it as
  // its transport's tools and /api/integrations/test refuses to build an HTTP
  // probe for it. What such a declaration still owes is coherence with itself.
  if (i.transport !== "http") {
    if (!NON_HTTP_TRANSPORTS.has(i.transport)) {
      add(`transport:${i.id}`, i.file, `declares transport "${i.transport}", which normalizeTransport() does not know — it degrades to "http" at runtime, so the integration is advertised and probed as an HTTP API it is not`);
    } else if (i.baseUrl) {
      add(`transport:${i.id}`, i.file, `declares non-HTTP transport "${i.transport}" but also a baseUrl ("${i.baseUrl}") — one of the two is a lie about how this integration is reached`);
    }
    continue;
  }
  const nonHttp = i.endpoints.filter((e) => !e.path.startsWith("/"));
  if (i.baseUrl && nonHttp.length > 0) {
    add(`transport:${i.id}`, i.file, `baseUrl declares an HTTP API but ${nonHttp.length} endpoint path(s) are not HTTP paths: ${nonHttp.map((e) => e.path).join(", ")}`);
  }
  if (!i.baseUrl && i.endpoints.length > 0) {
    add(
      `transport:${i.id}`,
      i.file,
      `baseUrl is empty, so http_request cannot reach these ${i.endpoints.length} endpoint(s) (${i.endpoints.map((e) => e.path).join(", ")}); the agent prompt still advertises them under an empty "Base URL:", and /api/integrations/test joins them onto "" to build a nonsense test URL`,
    );
  }
}

// ------------------------------------------------ CHECK 4: credential drift

// What the install path persists is the DECLARED LIST, not the primary alone:
// resolveInstallValues() in src/routes/bridges/integrations.ts pairs every
// supplied value with the credential it was declared under, vaults the secret
// ones and routes the `secret: false` ones to the transport's config sink. The
// Settings modal renders one field per declared credential to match.
//
// So the declaration is what the runtime and the instructions are measured
// against, and "unstorable" means "resolved at runtime, or asked of the user,
// but never DECLARED" — a value with no name the install path can bind it to.
// Measuring against the primary alone was this check's own staleness: it made
// every correctly-declared multi-credential integration look broken.
const CRED_SUFFIX = /_(PASS|PASSWORD|TOKEN|KEY|SECRET)$/;
const toolFamilyFiles = new Map(); // integration id -> source files of its tool family
const toolNames = new Set();

for (const file of sourceFiles) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/\bname:\s*["']([a-z][a-z0-9_]*_[a-z0-9_]+)["']/g)) toolNames.add(m[1]);
}
for (const i of integrations) {
  const files = sourceFiles.filter((f) => rel(f).startsWith(`src/tools/${i.id}-`) || rel(f).startsWith(`src/tools/${i.id}/`));
  if (files.length) toolFamilyFiles.set(i.id, files);
}

for (const i of integrations) {
  const primary = i.credentials[0];
  if (!primary) { add(`secret:${i.id}`, i.file, "no credentials declared — install path has nothing to store"); continue; }
  const storable = new Set(i.credentials);

  // (a) Credentials the dedicated tool family actually resolves at runtime.
  const resolved = new Set();
  for (const f of toolFamilyFiles.get(i.id) ?? []) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/\b(?:vault|env)\(\s*["']([A-Z][A-Z0-9_]*)["']\s*\)/g)) resolved.add(m[1]);
    for (const m of text.matchAll(/\bprocess\.env\.([A-Z][A-Z0-9_]*)/g)) resolved.add(m[1]);
    for (const m of text.matchAll(/\bkey\s*===\s*["']([A-Z][A-Z0-9_]*_(?:PASS|TOKEN|KEY|SECRET))["']/g)) resolved.add(m[1]);
  }
  const unstorable = [...resolved].filter((n) => CRED_SUFFIX.test(n) && !storable.has(n));
  if (unstorable.length > 0) {
    add(
      `secret:${i.id}`,
      i.file,
      `runtime resolves credential(s) the install path cannot store: ${unstorable.join(", ")} — undeclared, so /api/integrations/install has no name to bind a value to (integration declares [${i.credentials.join(", ")}], primary "${primary}")`,
    );
  }

  // (b) authInstructions that promise config no declared credential collects.
  // The Settings modal renders one input per DECLARED credential, so a value
  // the instructions name and the declaration omits has nowhere to be typed.
  const promised = [...new Set([...i.authInstructions.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)].map((m) => m[1]))];
  const extra = promised.filter((n) => !storable.has(n));
  if (extra.length > 0) {
    add(
      `secret:${i.id}`,
      i.file,
      `authInstructions ask the user for ${promised.length} values (${promised.join(", ")}) but ${extra.length} of them are not declared credentials (${extra.join(", ")}), so the install modal renders no field for them and they are silently dropped`,
    );
  }
}

// ------------------------------------------------------ CHECK 5: runtime path

for (const i of integrations) {
  const viaHttp = Boolean(i.baseUrl) && i.endpoints.every((e) => e.path.startsWith("/"));
  const viaTools = [...toolNames].some((t) => t.startsWith(`${i.id}_`));
  if (!viaHttp && !viaTools) {
    add(`runtime:${i.id}`, i.file, "no runtime path — not reachable via http_request (no usable baseUrl) and no dedicated tool family exists");
  }
}

// ------------------------------------------------------------------- baseline

let baseline = [];
if (existsSync(BASELINE_PATH)) {
  try { baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")).known ?? []; }
  catch { console.error(`check-integration-conformance: FAIL — ${rel(BASELINE_PATH)} is not valid JSON.`); process.exit(1); }
}
const baselined = new Map(baseline.map((b) => [b.id, b.note ?? ""]));
const fresh = findings.filter((f) => !baselined.has(f.id));
const seen = new Set(findings.map((f) => f.id));
const stale = [...baselined.keys()].filter((id) => !seen.has(id));

const group = (list) => {
  const out = new Map();
  for (const f of list) (out.get(f.id) ?? out.set(f.id, []).get(f.id)).push(f);
  return out;
};

if (baselined.size > 0) {
  console.warn(`check-integration-conformance: ${baselined.size} KNOWN violation(s) held in the baseline — this is the fix backlog, not a pass:`);
  for (const [id, items] of group(findings.filter((f) => baselined.has(f.id)))) {
    console.warn(`  - ${id} (${items[0].file})`);
    console.warn(`      ${items[0].detail}`);
    if (baselined.get(id)) console.warn(`      note: ${baselined.get(id)}`);
  }
}

if (stale.length > 0) {
  console.error("check-integration-conformance: FAIL — baseline entries that no longer reproduce. Delete them (the baseline may only shrink):");
  for (const id of stale) console.error(`  - ${id}`);
  process.exit(1);
}

if (fresh.length > 0) {
  console.error(`check-integration-conformance: FAIL — ${fresh.length} new plug-and-play violation(s):`);
  for (const [id, items] of group(fresh)) {
    console.error(`  - ${id} (${items[0].file})`);
    for (const it of items) console.error(`      ${it.detail}`);
  }
  console.error("\nFix the declaration or the runtime path. Do not add to the baseline to silence this.");
  process.exit(1);
}

console.log(
  `check-integration-conformance: OK (${integrations.length} integrations, ${toolNames.size} tool names scanned, ${baselined.size} known violation(s) in baseline)`,
);
