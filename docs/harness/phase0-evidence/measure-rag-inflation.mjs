#!/usr/bin/env node
// measure-rag-inflation.mjs — demonstrates what selectTools() ships for weak /
// medium models when the tool-RAG index is READY (production after boot
// pre-warm, src/server/index.ts:157-171). Uses a deterministic STUB embedder
// (hash-derived unit vectors), so the *non-pinned* semantic picks are
// meaningless — but the pinned set (every main-chat eager tool, passed as
// corePinned in tool-selection.ts:200) is what drives the union, and that is
// independent of embedding quality. READ-ONLY; run from the repo root:
//   LAX_DATA_DIR=<scratch>/audit/laxdata npx tsx <scratch>/audit/measure-rag-inflation.mjs
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { createHash } from "node:crypto";

const root = process.cwd();
const src = (p) => pathToFileURL(join(root, "src", p)).href;
if (!process.env.LAX_DATA_DIR) { console.error("set LAX_DATA_DIR to a scratch dir"); process.exit(2); }

const { plugins } = await import(src("tools/plugins.js"));
const { unifiedRegistry } = await import(src("tools/registry.js"));
const { applyAudiences } = await import(src("tools/audience-map.js"));
const ctx = {
  secretsStore: { get: () => undefined, list: () => [], has: () => false, getAll: () => ({}) },
  memoryIndex: {}, cronService: {}, dataDir: process.env.LAX_DATA_DIR,
  activeOnEventBySession: new Map(), activeBrowserSessionIdRef: { value: "default" },
  activeRuntimeBySession: new Map(), registry: unifiedRegistry,
};
const ordered = []; const seen = new Set();
for (const plugin of plugins) {
  try {
    const produced = await Promise.race([plugin.register(ctx), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000).unref())]);
    applyAudiences(produced);
    for (const t of produced ?? []) { if (!seen.has(t.name)) { seen.add(t.name); ordered.push(t); } }
  } catch {}
}

// Stub embedder: 64-dim unit vector from sha256 of the text. Deterministic.
function embedStub(text) {
  const h = createHash("sha256").update(text).digest();
  const v = Array.from({ length: 64 }, (_, i) => (h[i % h.length] / 255) * 2 - 1);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}
const { getToolRAG } = await import(src("tools/tool-rag.js"));
const rag = getToolRAG();
rag.setEmbedder({ embed: async (t) => embedStub(t) });
await rag.build(ordered);
console.log(`rag.isReady=${rag.isReady} size=${rag.size}`);

const { selectTools, _resetSessionToolsForTests } = await import(src("agent-request/prepare-request/tool-selection.js"));
const { toOpenAITools } = await import(src("providers/shared/tool-shape.js"));
const MESSAGE = "find the CRM project in my workspace";
for (const m of ["llama3.2:3b", "qwen3:8b", "qwen3.6:27b", "muse-glimmer:30b"]) {
  _resetSessionToolsForTests();
  const sel = await selectTools({ message: MESSAGE, sessionId: `rag-${m}`, channel: "web", allAgentTools: ordered, bridgeTools: [], resolvedProvider: "local", resolvedModel: m });
  const wire = JSON.stringify(toOpenAITools(sel.tools));
  console.log(`${m} tier=${sel.tier} tools=${sel.tools.length} wireChars=${wire.length} tok/3.5=${Math.ceil(wire.length / 3.5)} tok/4=${Math.ceil(wire.length / 4)}`);
  console.log(`  names: ${sel.tools.map((t) => t.name).join(", ")}`);
}
process.exit(0);
