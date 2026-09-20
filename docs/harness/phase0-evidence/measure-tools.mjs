#!/usr/bin/env node
// measure-tools.mjs — READ-ONLY measurement for the Phase-0 tool-surface /
// prompt-assembly audit (docs/harness/LOCAL_MODEL_HARNESS_BRIEF.md §2 Q3/Q4).
//
// Run FROM THE REPO ROOT under tsx so it imports src/ (not a stale dist/):
//   LAX_DATA_DIR=<scratch>/audit/laxdata npx tsx <scratch>/audit/measure-tools.mjs
//
// It never boots a server, never touches ~/.lax (LAX_DATA_DIR is redirected to
// a scratch dir), never pulls or runs a model. Plugin registration uses a stub
// context with a 3s per-plugin timeout, mirroring scripts/measure-prompt-prefix.mjs.
//
// Everything it prints is either MEASURED (real builders, real catalog on this
// checkout) or clearly labelled SYNTHETIC (fixture-sized memory sections).
// Token numbers are estimates: ceil(len/3.5) mirrors estimateTokens() in
// src/context-manager/token-estimation.ts; len/4 is the brief's rule of thumb.
// There is NO tokenizer in the repo (see report).

import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";

const root = process.cwd();
const here = dirname(fileURLToPath(import.meta.url));
const src = (p) => pathToFileURL(join(root, "src", p)).href;
const est35 = (s) => Math.ceil(s.length / 3.5);
const est4 = (s) => Math.ceil(s.length / 4);
const notes = [];

if (!process.env.LAX_DATA_DIR) {
  console.error("REFUSING: set LAX_DATA_DIR to a scratch dir so nothing touches ~/.lax");
  process.exit(2);
}
mkdirSync(process.env.LAX_DATA_DIR, { recursive: true });

// ── 1. Catalog: static allTools + plugin-produced tools, in bootstrap order ──
const { allTools } = await import(src("tools.js"));
const { plugins } = await import(src("tools/plugins.js"));
const { unifiedRegistry } = await import(src("tools/registry.js"));
const { applyAudiences } = await import(src("tools/audience-map.js"));

const ctx = {
  secretsStore: { get: () => undefined, list: () => [], has: () => false, getAll: () => ({}) },
  memoryIndex: {},
  cronService: {},
  dataDir: process.env.LAX_DATA_DIR,
  activeOnEventBySession: new Map(),
  activeBrowserSessionIdRef: { value: "default" },
  activeRuntimeBySession: new Map(),
  registry: unifiedRegistry,
};

const ordered = [];      // bootstrap order (plugin order), first-wins on name
const seen = new Set();
const dupes = [];
const pluginReport = [];
for (const plugin of plugins) {
  try {
    const produced = await Promise.race([
      plugin.register(ctx),
      new Promise((_, rej) => setTimeout(() => rej(new Error("register() timed out (3s)")), 3000).unref()),
    ]);
    applyAudiences(produced);   // bootstrap-tools.ts:78 does this per plugin
    let n = 0;
    for (const t of produced ?? []) {
      n++;
      if (seen.has(t.name)) { dupes.push(`${t.name} (plugin=${plugin.id})`); continue; }
      seen.add(t.name);
      ordered.push(t);
    }
    pluginReport.push({ id: plugin.id, tools: n, ok: true });
  } catch (e) {
    pluginReport.push({ id: plugin.id, tools: 0, ok: false, err: String(e?.message ?? e).slice(0, 120) });
  }
}
notes.push(`static allTools = ${allTools.length}; plugin-merged catalog = ${ordered.length} (duplicates skipped: ${dupes.length})`);
if (dupes.length) notes.push(`duplicate names: ${dupes.join(", ")}`);

// ── 2. Availability gate + audiences ──
const { filterAvailableTools } = await import(src("tools/tool-search.js"));
const available = filterAvailableTools(ordered);
const unavailable = ordered.filter((t) => !available.includes(t)).map((t) => t.name);
notes.push(`availability gate on THIS process (LAX_DATA_DIR=scratch, so email/etc. unconfigured): ${ordered.length} raw -> ${available.length} available; hidden: ${unavailable.join(", ") || "(none)"}`);

const eagerMainChat = available.filter((t) => t.audiences?.includes("main-chat"));
const eagerAny = available.filter((t) => t.audiences && t.audiences.length > 0);
const deferred = available.filter((t) => !t.audiences || t.audiences.length === 0);

// ── 3. Per-tool schema stats on the LOCAL wire shape (openai-chat) ──
const { toOpenAITools, toAnthropicTools } = await import(src("providers/shared/tool-shape.js"));
function paramStats(t) {
  const p = t.parameters ?? {};
  const props = p.properties && typeof p.properties === "object" ? Object.keys(p.properties) : [];
  const req = Array.isArray(p.required) ? p.required.length : 0;
  return { params: props.length, required: req, optional: props.length - req };
}
function rowFor(t) {
  const wire = JSON.stringify(toOpenAITools([t])[0]);
  const anth = JSON.stringify(toAnthropicTools([t])[0]);
  const ps = paramStats(t);
  return {
    name: t.name,
    audiences: t.audiences ?? [],
    descChars: (t.description ?? "").length,
    compactChars: t.compactDescription ? t.compactDescription.length : null,
    ...ps,
    wireChars: wire.length,
    wireTok35: est35(wire),
    wireTok4: est4(wire),
    anthropicChars: anth.length,
  };
}
const rows = available.map(rowFor);
const totalWire = JSON.stringify(toOpenAITools(available));

// ── 4. Per-tier selection for a plain chat message, through the REAL selectTools() ──
const { selectTools, _resetSessionToolsForTests } = await import(src("agent-request/prepare-request/tool-selection.js"));
const { classifyModel, maxToolsForTier, ESSENTIAL_TOOLS_ORDER, MEDIUM_INTENT_SLOTS, GEMINI_STRONG_TOOL_CAP } = await import(src("model-tiers.js"));
const { buildDeferredToolManifest, buildToolPromptSection } = await import(src("tools/tool-prompt-builder.js"));

const MESSAGE = "find the CRM project in my workspace";
const MODELS = [
  { model: "llama3.2:3b", provider: "local" },
  { model: "qwen3:8b", provider: "local" },
  { model: "qwen3.6:27b", provider: "local" },
  { model: "muse-glimmer:30b", provider: "local" },
  { model: "claude-fable-5-1", provider: "anthropic" },
];
const selections = [];
for (const m of MODELS) {
  _resetSessionToolsForTests();
  const sel = await selectTools({
    message: MESSAGE,
    sessionId: `audit-${m.model}`,
    channel: "web",
    allAgentTools: ordered,      // selectTools takes the RAW catalog (bootstrap's allAgentTools)
    bridgeTools: [],
    resolvedProvider: m.provider,
    resolvedModel: m.model,
  });
  const wire = JSON.stringify(toOpenAITools(sel.tools));
  const manifest = buildDeferredToolManifest(available, sel.tools);
  const compacted = sel.tools.filter((t) => t.compactDescription && t.description === t.compactDescription).length;
  selections.push({
    model: m.model,
    provider: m.provider,
    tier: sel.tier,
    cap: maxToolsForTier(sel.tier),
    count: sel.tools.length,
    names: sel.tools.map((t) => t.name),
    wireChars: wire.length,
    wireTok35: est35(wire),
    wireTok4: est4(wire),
    perToolOverheadTok: 8 * sel.tools.length, // request-fit.ts PER_TOOL_OVERHEAD_TOKENS
    descTotalChars: sel.tools.reduce((s, t) => s + (t.description ?? "").length, 0),
    toolsUsingCompactDescription: compacted,
    manifestChars: manifest.length,
    manifestTok35: est35(manifest),
    manifestCount: available.length - sel.tools.filter((t) => available.some((a) => a.name === t.name)).length,
  });
}
// Same message, second turn of the same session (strong only grows; weak/medium re-pick) —
// demonstrate per-message re-selection by sending a different message on the same session.
_resetSessionToolsForTests();
const reselect = [];
for (const m of [{ model: "qwen3.6:27b", provider: "local" }, { model: "claude-fable-5-1", provider: "anthropic" }]) {
  const sid = `audit-reselect-${m.model}`;
  const a = await selectTools({ message: MESSAGE, sessionId: sid, channel: "web", allAgentTools: ordered, bridgeTools: [], resolvedProvider: m.provider, resolvedModel: m.model });
  const b = await selectTools({ message: "make me a spreadsheet of my sales", sessionId: sid, channel: "web", allAgentTools: ordered, bridgeTools: [], resolvedProvider: m.provider, resolvedModel: m.model });
  const c = await selectTools({ message: "thanks", sessionId: sid, channel: "web", allAgentTools: ordered, bridgeTools: [], resolvedProvider: m.provider, resolvedModel: m.model });
  const names = (s) => s.tools.map((t) => t.name);
  reselect.push({
    model: m.model, tier: a.tier,
    turn1: names(a).length, turn2: names(b).length, turn3: names(c).length,
    turn1_names: names(a), turn2_names: names(b), turn3_names: names(c),
    identical12: JSON.stringify(names(a)) === JSON.stringify(names(b)),
    identical23: JSON.stringify(names(b)) === JSON.stringify(names(c)),
  });
}

// Eager main-chat set with NO keyword hits (what a bare "hi" ships to strong):
const { filterToolsForMessage } = await import(src("agent-request/tool-filter.js"));
const bare = filterToolsForMessage(ordered, "hi");
const bareWire = JSON.stringify(toOpenAITools(bare));

// ── 5. Prompt assembly through the REAL builder ──
const { loadSystemPrompt } = await import(src("config-loader.js"));
const { createSystemPromptBuilder } = await import(src("context/system-prompt-builder.js"));
const { stableSystemPrefixLength, fileAccessGroundingBlock } = await import(src("agent-request/prepare-request/build-system-prompt.js"));
const { modelFamilyRiderFor } = await import(src("agent-request/prepare-request/provider-riders.js"));
const { channelContextBlock } = await import(src("channel-context.js"));
const { applyCapabilityAwarePromptDegradation, promptPriorityOf } = await import(src("context/prompt-degradation.js"));

const mediumSel = selections.find((s) => s.model === "qwen3.6:27b");
const mediumTools = ordered.filter((t) => mediumSel.names.includes(t.name));
const bestPractices = buildToolPromptSection(available);
const manifestMedium = buildDeferredToolManifest(available, mediumTools);

async function buildPrompt(opts) {
  const b = createSystemPromptBuilder({
    basePrompt: loadSystemPrompt(),
    providerHint: "\n\n[System: You are currently powered by Local (Ollama), model: qwen3.6:27b.]",
    toolPromptSection: bestPractices + manifestMedium,
    integrationsContext: "",
    memoryDir: undefined,            // project-catalog needs ~/.lax/memory — UNKNOWN here
    sessionId: "audit-session",
    contextBlock: opts.contextBlock ?? "",
    relevantMemories: opts.relevantMemories ?? "",
    smartContext: opts.smartContext ?? "",
    memoryContext: "",
    notificationHint: "",
    channelContext: channelContextBlock("web"),
  });
  // build-system-prompt.ts:307-317 adds these dynamic sections in this order:
  b.addSection({ id: "file-access", label: "File Access", type: "dynamic", policy: "required", build: () => fileAccessGroundingBlock("common") });
  b.addSection({ id: "model-family-rider", label: "Model Family Rider", type: "dynamic", policy: "required", build: () => modelFamilyRiderFor("qwen3.6:27b") });
  return b.buildWithTelemetry();
}

const floor = await buildPrompt({});
const sectionRows = floor.renderedSections.map((s) => ({
  id: s.id, type: s.type, policy: s.policy, priority: promptPriorityOf(s),
  chars: s.text.length, tok35: s.measurement.estimatedTokens, tok4: est4(s.text),
}));
const stablePrefix = stableSystemPrefixLength(floor.renderedSections);

// SYNTHETIC memory sections sized like the 2026-09-08 incident fixture in
// src/context/prompt-degradation.test.ts:356 (contextChars 14,600; memoryChars 3,000).
const synth = await buildPrompt({ contextBlock: "c".repeat(14_600), relevantMemories: "v".repeat(3_000), smartContext: "s".repeat(1_500) });

function profile(model, tier, contextWindow) {
  return { runtimeId: "ollama@127.0.0.1:11434", baseURL: "http://127.0.0.1:11434/v1", model, tier, maxTools: maxToolsForTier(tier), contextWindow, tools: { advertised: true, verified: null, rejectsTools: false } };
}
function degrade(built, label, prof) {
  const r = applyCapabilityAwarePromptDegradation(built.renderedSections, prof);
  const kept = r.sections.reduce((s, x) => s + x.measurement.estimatedTokens, 0);
  const full = built.renderedSections.reduce((s, x) => s + x.measurement.estimatedTokens, 0);
  return { label, mode: r.telemetry.mode, reason: r.telemetry.reason, budget: r.telemetry.promptBudgetTokens ?? null, fullTok35: full, keptTok35: kept, shed: r.telemetry.degradedSections.map((d) => d.id), kept_ids: r.telemetry.includedSectionIds };
}
const degradation = [
  degrade(floor, "floor(no memory) 32k weak", profile("qwen3:8b", "weak", 32_768)),
  degrade(floor, "floor(no memory) 65k medium", profile("qwen3.6:27b", "medium", 65_536)),
  degrade(floor, "floor(no memory) cloud/unlimited", null),
  degrade(synth, "synthetic-memory 32k weak", profile("qwen3:8b", "weak", 32_768)),
  degrade(synth, "synthetic-memory 65k medium", profile("qwen3.6:27b", "medium", 65_536)),
  degrade(synth, "synthetic-memory 8k floor (LOCAL_UNKNOWN_CONTEXT) medium", profile("qwen3.6:27b", "medium", null)),
];

// ── 5b. Per-tool wire sizes INSIDE the compacted weak/medium selections ──
// (selectTools returns the compacted copies, so measuring its output is the wire.)
const tierRows = {};
for (const m of [{ model: "qwen3:8b", provider: "local" }, { model: "qwen3.6:27b", provider: "local" }]) {
  _resetSessionToolsForTests();
  const sel = await selectTools({ message: MESSAGE, sessionId: `audit-rows-${m.model}`, channel: "web", allAgentTools: ordered, bridgeTools: [], resolvedProvider: m.provider, resolvedModel: m.model });
  tierRows[m.model] = sel.tools.map((t) => {
    const wire = JSON.stringify(toOpenAITools([t])[0]);
    const ps = paramStats(t);
    return { name: t.name, descChars: (t.description ?? "").length, ...ps, wireChars: wire.length, wireTok35: est35(wire) };
  }).sort((a, b) => b.wireChars - a.wireChars);
}

// ── 6. Output ──
const out = {
  tierRows,
  message: MESSAGE,
  catalog: { staticAllTools: allTools.length, merged: ordered.length, available: available.length, unavailableHere: unavailable, eagerMainChat: eagerMainChat.length, eagerAnyAudience: eagerAny.length, deferred: deferred.length, plugins: pluginReport },
  tiers: { ESSENTIAL_TOOLS_ORDER: [...ESSENTIAL_TOOLS_ORDER], MEDIUM_INTENT_SLOTS, GEMINI_STRONG_TOOL_CAP, caps: { weak: maxToolsForTier("weak"), medium: maxToolsForTier("medium"), strong: maxToolsForTier("strong") }, classify: Object.fromEntries(MODELS.map((m) => [m.model, classifyModel(m.model)])) },
  fullCatalogWire: { chars: totalWire.length, tok35: est35(totalWire), tok4: est4(totalWire) },
  bareEagerMainChat: { count: bare.length, chars: bareWire.length, tok35: est35(bareWire), tok4: est4(bareWire), names: bare.map((t) => t.name) },
  selections,
  reselect,
  largest15: [...rows].sort((a, b) => b.wireChars - a.wireChars).slice(0, 15),
  rows,
  prompt: { basePromptChars: loadSystemPrompt().length, basePromptTok35: est35(loadSystemPrompt()), bestPracticesChars: bestPractices.length, manifestMediumChars: manifestMedium.length, totalChars: floor.prompt.length, totalTok35: est35(floor.prompt), totalTok4: est4(floor.prompt), stablePrefixChars: stablePrefix, sections: sectionRows, order: floor.renderedSections.map((s) => s.id) },
  degradation,
  notes,
};
writeFileSync(join(here, "measure-tools.out.json"), JSON.stringify(out, null, 2));

// Markdown summary to stdout
const md = [];
md.push(`## Catalog`, `- static allTools: ${out.catalog.staticAllTools}; merged plugin catalog: ${out.catalog.merged}; available here: ${out.catalog.available}; eager main-chat: ${out.catalog.eagerMainChat}; eager any-audience: ${out.catalog.eagerAnyAudience}; deferred (no audience): ${out.catalog.deferred}`);
md.push(`- plugins: ${pluginReport.map((p) => `${p.id}=${p.ok ? p.tools : "SKIP(" + p.err + ")"}`).join(", ")}`);
md.push(`- full available catalog on the openai-chat wire: ${out.fullCatalogWire.chars} chars ≈ ${out.fullCatalogWire.tok35} tok(/3.5) ≈ ${out.fullCatalogWire.tok4} tok(/4)`);
md.push(`- bare eager main-chat set ("hi"): ${out.bareEagerMainChat.count} tools, ${out.bareEagerMainChat.chars} chars ≈ ${out.bareEagerMainChat.tok35} tok(/3.5)`);
md.push(``, `## Selections for "${MESSAGE}"`, `| model | tier | cap | tools | wire chars | tok/3.5 | tok/4 | compacted | manifest chars |`, `|---|---|---|---|---|---|---|---|---|`);
for (const s of selections) md.push(`| ${s.model} | ${s.tier} | ${s.cap === Number.MAX_SAFE_INTEGER ? "∞" : s.cap} | ${s.count} | ${s.wireChars} | ${s.wireTok35} | ${s.wireTok4} | ${s.toolsUsingCompactDescription} | ${s.manifestChars} |`);
for (const s of selections) md.push(`- ${s.model} (${s.tier}): ${s.names.join(", ")}`);
md.push(``, `## Re-selection across turns (same session)`);
for (const r of reselect) md.push(`- ${r.model} (${r.tier}): turn1=${r.turn1} turn2=${r.turn2} turn3=${r.turn3}; identical(1,2)=${r.identical12} identical(2,3)=${r.identical23}`);
md.push(``, `## 15 largest tools (openai-chat wire)`, `| tool | desc chars | compact | params | req | opt | wire chars | tok/3.5 | audiences |`, `|---|---|---|---|---|---|---|---|---|`);
for (const r of out.largest15) md.push(`| ${r.name} | ${r.descChars} | ${r.compactChars ?? "-"} | ${r.params} | ${r.required} | ${r.optional} | ${r.wireChars} | ${r.wireTok35} | ${r.audiences.join("/") || "deferred"} |`);
for (const [model, trs] of Object.entries(tierRows)) {
  md.push(``, `## Per-tool wire sizes in the ${model} selection (compacted)`, `| tool | desc chars | params | req | opt | wire chars | tok/3.5 |`, `|---|---|---|---|---|---|---|`);
  for (const r of trs) md.push(`| ${r.name} | ${r.descChars} | ${r.params} | ${r.required} | ${r.optional} | ${r.wireChars} | ${r.wireTok35} |`);
}
md.push(``, `## Prompt sections (order = final system prompt order; memory sections empty here)`, `| # | id | type | class | chars | tok/3.5 |`, `|---|---|---|---|---|---|`);
sectionRows.forEach((s, i) => md.push(`| ${i + 1} | ${s.id} | ${s.type} | ${s.priority} | ${s.chars} | ${s.tok35} |`));
md.push(`- total: ${out.prompt.totalChars} chars ≈ ${out.prompt.totalTok35} tok(/3.5) ≈ ${out.prompt.totalTok4} tok(/4); stableSystemPrefixLength = ${stablePrefix} chars`);
md.push(``, `## Degradation`);
for (const d of degradation) md.push(`- ${d.label}: mode=${d.mode} reason=${d.reason} budget=${d.budget} full=${d.fullTok35} kept=${d.keptTok35} shed=[${d.shed.join(", ")}]`);
md.push(``, `## Notes`, ...notes.map((n) => `- ${n}`));
console.log(md.join("\n"));
process.exit(0);
