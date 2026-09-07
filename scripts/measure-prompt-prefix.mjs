#!/usr/bin/env node
/**
 * measure-prompt-prefix.mjs — MEASUREMENT ONLY. Reports the two numbers the
 * prompt-cost work is argued from, so both are reproducible by anyone:
 *
 *   1. TOOL SCHEMA COST — the real tool catalog serialized into the Anthropic
 *      wire shape (`{ name, description, input_schema }`, the exact output of
 *      toAnthropicTools() in src/providers/shared/tool-shape.ts), plus the size
 *      of the deferred-tool manifest built from it.
 *   2. STABLE SYSTEM-PROMPT PREFIX — assembles a real system prompt through
 *      createSystemPromptBuilder() and runs the SHIPPING stableSystemPrefixLength()
 *      over the rendered sections, so the cache-prefix figure is not a hand count.
 *
 * MUST BE RUN UNDER tsx — it imports `src/`, not `dist/`, on purpose: a stale
 * dist would silently report the numbers of a different tree.
 *
 *   npx tsx scripts/measure-prompt-prefix.mjs [--plugins] [--json]
 *
 * It does not build, boot a server, or touch live state. Plugin registration is
 * attempted with a stub context inside a per-plugin try/catch; plugins that need
 * real services are skipped and reported, so every number is labelled
 * measured-or-missing.
 *
 * REPRODUCIBILITY: every run prints a SNAPSHOT header — git HEAD, working-tree
 * dirtiness, node version, whether --plugins was passed, the tool COUNT, and a
 * sha256 over the sorted tool-name list. Two runs whose snapshot lines match are
 * measuring the same catalog; two runs whose snapshots differ are not comparable
 * and their numbers must not be quoted against each other. This is the exact
 * failure the earlier untracked version of this script caused: numbers taken
 * over the RAW 176-tool catalog were later compared against numbers taken over
 * the AVAILABILITY-FILTERED catalog, which is a different, smaller set.
 *
 * TOKEN NUMBERS ARE ESTIMATES: `estimateTokens = ceil(len / 3.5)`, mirroring
 * estimateTokens() in the product. NOT a tokenizer. Byte counts are measured.
 */
import { pathToFileURL } from "node:url";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const src = (p) => pathToFileURL(join(root, "src", p)).href;

const est = (s) => Math.ceil(s.length / 3.5); // mirrors estimateTokens()
const bytes = (s) => Buffer.byteLength(s, "utf8");

function anthropicShape(t) {
  return { name: t.name, description: t.description ?? "", input_schema: t.parameters ?? {} };
}

function git(...args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch { return "(unavailable)"; }
}

const withPlugins = process.argv.includes("--plugins");
const catalog = new Map();
const notes = [];

// 1. Static catalog — src/tools.ts allTools
try {
  const { allTools } = await import(src("tools.js"));
  for (const t of allTools) catalog.set(t.name, t);
  notes.push(`allTools: ${allTools.length} tools (measured)`);
} catch (e) {
  notes.push(`allTools: FAILED — ${e.message}`);
}

// 2. Plugin-produced tools — best effort with a stub context.
// OFF by default: several plugins open sockets/subprocesses on register and
// never settle, which hangs the process. Pass --plugins to attempt them.
// NOTE: the production catalog DOES include plugin tools, so a run without
// --plugins measures a strict subset and its numbers are not the live ones.
if (!withPlugins) {
  notes.push("plugins: NOT ATTEMPTED (pass --plugins). Static catalog only — this is a SUBSET of the live catalog.");
} else try {
  const { plugins } = await import(src("tools/plugins.js"));
  const { unifiedRegistry } = await import(src("tools/registry.js"));
  const ctx = {
    secretsStore: { get: () => undefined, list: () => [], has: () => false },
    memoryIndex: {},
    cronService: {},
    dataDir: join(root, ".measure-tmp-never-written"),
    activeOnEventBySession: new Map(),
    activeBrowserSessionIdRef: { value: "default" },
    activeRuntimeBySession: new Map(),
    registry: unifiedRegistry,
  };
  let ok = 0, failed = 0;
  for (const plugin of plugins) {
    try {
      // Hard per-plugin timeout: register() is supposed to be pure catalog
      // construction, but a few open sockets/subprocesses and never settle.
      const produced = await Promise.race([
        plugin.register(ctx),
        new Promise((_, rej) => setTimeout(() => rej(new Error("register() timed out (3s)")), 3000).unref()),
      ]);
      for (const t of produced ?? []) if (!catalog.has(t.name)) catalog.set(t.name, t);
      ok++;
    } catch (e) {
      failed++;
      notes.push(`plugin ${plugin.id}: SKIPPED — ${e.message?.slice(0, 90)}`);
    }
  }
  notes.push(`plugins: ${ok} registered, ${failed} skipped (measured for the registered ones)`);
} catch (e) {
  notes.push(`plugins: FAILED — ${e.message}`);
}

// 3. Availability gate. build-system-prompt.ts passes filterAvailableTools(all)
// into the manifest builder, NOT the raw catalog — a tool whose available()
// predicate is false on this machine is withheld from both the schema and the
// manifest. Every "what actually ships" number below is the FILTERED one; the
// raw figure is kept only so a run can be reconciled against one that forgot
// the gate.
let available = [...catalog.values()];
try {
  const { filterAvailableTools } = await import(src("tools/tool-search.js"));
  available = filterAvailableTools([...catalog.values()]);
  notes.push(`availability gate: ${catalog.size} raw → ${available.length} available on THIS machine (measured)`);
} catch (e) {
  notes.push(`availability gate: FAILED — ${e.message} (falling back to raw catalog)`);
}

// 4. Audience tagging + the main-chat eager set.
let mainChat = [];
try {
  const { AUDIENCES_BY_TOOL } = await import(src("tools/audience-map.js"));
  mainChat = available.filter(
    (t) => (AUDIENCES_BY_TOOL[t.name] ?? []).includes("main-chat"),
  );
  notes.push(`audience-map: ${Object.keys(AUDIENCES_BY_TOOL).length} entries; main-chat eager = ${mainChat.length} of the available set (measured)`);
} catch (e) {
  notes.push(`audience-map: FAILED — ${e.message}`);
}

function report(label, tools) {
  const rows = tools
    .map((t) => {
      const json = JSON.stringify(anthropicShape(t));
      return {
        name: t.name,
        bytes: bytes(json),
        descBytes: bytes(t.description ?? ""),
        schemaBytes: bytes(JSON.stringify(t.parameters ?? {})),
        estTokens: est(json),
      };
    })
    .sort((a, b) => b.bytes - a.bytes);
  const arrayJson = JSON.stringify(tools.map(anthropicShape));
  return {
    label,
    count: tools.length,
    arrayBytes: bytes(arrayJson),
    arrayEstTokens: est(arrayJson),
    rows,
  };
}

const raw = report("RAW CATALOG", [...catalog.values()]);
const avail = report("AVAILABLE CATALOG", available);
const eager = report("MAIN-CHAT EAGER", mainChat);

// Snapshot identity — makes two runs comparable, or provably not.
const snapshotNames = available.map((t) => t.name).sort();
const snapshotHash = createHash("sha256").update(snapshotNames.join("\n")).digest("hex").slice(0, 12);
const dirty = git("status", "--porcelain") ? "DIRTY" : "clean";

// The two halves of the `tool-guidance` prompt section, measured with the real
// builders rather than re-implemented here, over the SAME availability-filtered
// catalog build-system-prompt.ts passes them.
let guidanceBestPractices = -1, guidanceManifest = -1, manifestText = "";
try {
  const { buildToolPromptSection, buildDeferredToolManifest } = await import(src("tools/tool-prompt-builder.js"));
  guidanceBestPractices = bytes(buildToolPromptSection(available));
  manifestText = buildDeferredToolManifest(available, mainChat);
  guidanceManifest = bytes(manifestText);
} catch (e) {
  notes.push(`tool-guidance: FAILED — ${e.message}`);
}
const deferredCount = available.length - mainChat.length;

// 5. STABLE SYSTEM-PROMPT PREFIX. Assembled through the real builder and
// measured with the real stableSystemPrefixLength(), so this cannot drift from
// what ships. Two figures are printed on purpose:
//
//   SHIPPING   — what stableSystemPrefixLength() returns. Sections the agent's
//                own writes churn (app-manifest, agents-md) are excluded, so
//                this number still holds during an app-build / self_edit
//                session, which is the workload the split exists for.
//   QUIESCENT  — the hypothetical if those churning sections counted. It is the
//                bigger, prettier number and it is NOT what ships; it only holds
//                on a repo nothing is writing to. Printed so nobody quotes it by
//                accident, and labelled as the hypothetical it is.
const prefix = { shipping: null, quiescent: null, sections: [], total: 0 };
try {
  const { createSystemPromptBuilder } = await import(src("context/system-prompt-builder.js"));
  const { stableSystemPrefixLength } = await import(src("agent-request/prepare-request/build-system-prompt.js"));
  const { loadSystemPrompt } = await import(src("config-loader.js"));
  const built = await createSystemPromptBuilder({
    basePrompt: loadSystemPrompt() || "",
    providerHint: "\n\n[System: You are currently powered by Anthropic Claude, model: measure.]",
    toolPromptSection: manifestText,
    integrationsContext: "",
    contextBlock: "",
    relevantMemories: "",
  }).buildWithTelemetry();

  prefix.total = built.prompt.length;
  prefix.shipping = stableSystemPrefixLength(built.renderedSections) ?? 0;
  prefix.sections = built.renderedSections.map((s) => ({
    id: s.id, type: s.type, chars: s.text.length, bytes: bytes(s.text),
  }));
  // QUIESCENT: continue the same leading-run walk, but pretend the two
  // agent-churned sections are stable. Deliberately duplicated here (this is a
  // measurement script, not a second implementation of the shipping rule) and
  // labelled everywhere it is printed.
  const quiescentStop = new Set(["tool-guidance", "project-catalog", "integrations"]);
  let q = 0;
  for (const s of built.renderedSections) {
    if (s.type !== "static" || quiescentStop.has(s.id)) break;
    q += s.text.length;
  }
  prefix.quiescent = q;

  // Guard the one property the whole feature rests on.
  if (built.prompt.slice(0, prefix.shipping) !== built.renderedSections
        .reduce((acc, s) => acc.length >= prefix.shipping ? acc : acc + s.text, "")
        .slice(0, prefix.shipping)) {
    notes.push("PREFIX PROPERTY VIOLATED — the reported length is not a contiguous prefix.");
  }
} catch (e) {
  notes.push(`system-prompt prefix: FAILED — ${e.message}`);
}

const out = {
  snapshot: {
    gitHead: git("rev-parse", "--short", "HEAD"),
    workingTree: dirty,
    node: process.version,
    plugins: withPlugins,
    availableToolCount: available.length,
    rawToolCount: catalog.size,
    catalogSha256_12: snapshotHash,
  },
  notes,
  rawCatalog: { count: raw.count, arrayBytes: raw.arrayBytes, arrayEstTokens: raw.arrayEstTokens },
  availableCatalog: { count: avail.count, arrayBytes: avail.arrayBytes, arrayEstTokens: avail.arrayEstTokens },
  mainChatEager: { count: eager.count, arrayBytes: eager.arrayBytes, arrayEstTokens: eager.arrayEstTokens },
  toolGuidance: {
    deferredCount,
    bestPracticesBytes: guidanceBestPractices,
    deferredManifestBytes: guidanceManifest,
  },
  systemPromptPrefix: prefix,
  eagerRows: eager.rows,
  availableRows: avail.rows,
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`# SNAPSHOT git=${out.snapshot.gitHead} tree=${dirty} node=${process.version} plugins=${withPlugins} tools=${available.length} catalog-sha256=${snapshotHash}`);
  console.log("# token counts are estimates: ceil(len/3.5), NOT a tokenizer. byte counts are measured.");
  for (const n of notes) console.log(`# ${n}`);
  console.log("");
  console.log(`RAW CATALOG        : ${raw.count} tools, ${raw.arrayBytes} bytes JSON, ~${raw.arrayEstTokens} est tokens`);
  console.log(`AVAILABLE CATALOG  : ${avail.count} tools, ${avail.arrayBytes} bytes JSON, ~${avail.arrayEstTokens} est tokens  <- what the prompt is built from`);
  console.log(`MAIN-CHAT EAGER    : ${eager.count} tools, ${eager.arrayBytes} bytes JSON, ~${eager.arrayEstTokens} est tokens`);
  console.log("");
  console.log(`TOOL-GUIDANCE best-practices   : ${guidanceBestPractices} bytes (~${Math.ceil(guidanceBestPractices / 3.5)} est tok)`);
  console.log(`TOOL-GUIDANCE deferred manifest: ${guidanceManifest} bytes (~${Math.ceil(guidanceManifest / 3.5)} est tok) for ${deferredCount} deferred tools`);
  console.log("");
  console.log(`SYSTEM PROMPT total            : ${prefix.total} chars`);
  console.log(`STABLE PREFIX (SHIPPING)       : ${prefix.shipping} chars (~${Math.ceil((prefix.shipping ?? 0) / 3.5)} est tok) — holds during app-build/self_edit`);
  console.log(`STABLE PREFIX (QUIESCENT, N/A) : ${prefix.quiescent} chars (~${Math.ceil((prefix.quiescent ?? 0) / 3.5)} est tok) — HYPOTHETICAL, only on a repo nothing is writing to`);
  console.log("");
  console.log("SECTIONS (id | type | chars)");
  for (const s of prefix.sections) console.log(`${String(s.chars).padStart(7)} | ${s.type.padEnd(7)} | ${s.id}`);
  console.log("");
  console.log("EAGER TOOLS BY SERIALIZED SIZE (bytes | desc | schema | ~tok | name)");
  for (const r of eager.rows) {
    console.log(`${String(r.bytes).padStart(6)} | ${String(r.descBytes).padStart(5)} | ${String(r.schemaBytes).padStart(5)} | ${String(r.estTokens).padStart(5)} | ${r.name}`);
  }
}

process.exit(0);
