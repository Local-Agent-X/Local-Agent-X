// @vitest-environment happy-dom
//
// /api/providers/registry had five independent readers in the renderer — the
// apps gallery, the IDE model picker, the missions modal, the agents team
// panel, and the chat model chip. They had already drifted: the IDE reached
// into apps.js's globals to dodge a second fetch, the missions modal refetched
// on every open, and the agents panel cached [] on failure so one failed
// first-open stranded its picker for the session.
//
// provider-registry.js is now the one reader. These tests pin both halves:
// nobody else fetches the endpoint, and the reader's caching behaviour is the
// behaviour the callers were each getting wrong.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const jsDir = join(here, "../public/js");
const CANONICAL = "provider-registry.js";
const src = readFileSync(join(jsDir, CANONICAL), "utf8");
const html = readFileSync(join(here, "../public/app.html"), "utf8");

// Executable source only. Every consumer names the endpoint in a comment now,
// explaining what it stopped doing — those must not read as a second reader.
// `[^:]` keeps `https://` inside a string literal from starting a comment;
// split on \r?\n because the repo checks out CRLF.
function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".js") ? [join(dir, e.name)] : [],
  );
}

function load(providers: unknown, opts: { failFirst?: number } = {}) {
  let calls = 0;
  let failFor = opts.failFirst ?? 0;
  // Stand in for shared-api.js's apiFetch. Counting calls is the point: the
  // cache is the behaviour, not an implementation detail.
  (globalThis as Record<string, unknown>).apiFetch = async () => {
    calls++;
    if (failFor > 0) { failFor--; throw new Error("network"); }
    return { json: async () => ({ providers }) };
  };
  const mod = new Function(`${src}\nreturn { laxProviderRegistry, laxProviderOptions, laxProviderModels, laxProviderLabels };`)();
  return {
    registry: mod.laxProviderRegistry as () => Promise<Array<{ id: string }>>,
    laxProviderOptions: mod.laxProviderOptions as (r: unknown) => Array<{ value: string; label: string }>,
    laxProviderModels: mod.laxProviderModels as (r: unknown) => Record<string, string[]>,
    laxProviderLabels: mod.laxProviderLabels as (r: unknown) => Record<string, string>,
    calls: () => calls,
  };
}

const PROVIDERS = [
  { id: "xai", label: "xAI Grok", models: ["grok-4.5", "grok-4.3"], defaultModel: "grok-4.5" },
  { id: "codex", label: "OpenAI Codex", models: ["gpt-5.5"], defaultModel: "gpt-5.5" },
];

let api: ReturnType<typeof load>;
beforeEach(() => { api = load(PROVIDERS); });

describe("provider registry — one reader", () => {
  it("is the only module that fetches the endpoint", () => {
    const offenders = walk(jsDir)
      .filter((f) => !f.endsWith(CANONICAL))
      .filter((f) => stripComments(readFileSync(f, "utf8")).includes("/api/providers/registry"));
    expect(offenders.map((f) => f.slice(jsDir.length + 1))).toEqual([]);
  });

  it("loads before every consumer in app.html", () => {
    const at = (f: string) => html.indexOf(`/js/${f}`);
    expect(at(CANONICAL)).toBeGreaterThan(-1);
    for (const consumer of ["chat-provider-identity.js", "cron-actions.js", "apps.js", "apps-ide.js", "agents.js"]) {
      expect.soft(at(CANONICAL), `${CANONICAL} must precede ${consumer}`).toBeLessThan(at(consumer));
    }
  });

  it("fetches once and serves the cache thereafter", async () => {
    await api.registry();
    await api.registry();
    await api.registry();
    expect(api.calls()).toBe(1);
  });

  it("collapses concurrent callers into one request", async () => {
    // The apps gallery and the IDE picker can initialise on the same tick.
    const [a, b, c] = await Promise.all([api.registry(), api.registry(), api.registry()]);
    expect(api.calls()).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("does NOT cache a failure — the picker must recover on the next open", async () => {
    // agents/team.js cached [] here, so one failed first-open left the model
    // picker empty until a page reload.
    const flaky = load(PROVIDERS, { failFirst: 1 });
    expect(await flaky.registry()).toEqual([]);
    expect(await flaky.registry()).toHaveLength(2);
    expect(flaky.calls()).toBe(2);
  });

  it("does not cache an empty success either", async () => {
    // A registry with zero providers means the server isn't ready, not that the
    // app has no providers.
    const empty = load([]);
    expect(await empty.registry()).toEqual([]);
    await empty.registry();
    expect(empty.calls()).toBe(2);
  });

  it("survives a malformed payload without throwing", async () => {
    for (const shape of [null, undefined, "nope", { nested: true }]) {
      const bad = load(shape);
      await expect(bad.registry()).resolves.toEqual([]);
    }
  });

  it("derives every shape the five callers were building by hand", async () => {
    const reg = await api.registry();
    expect(api.laxProviderOptions(reg)).toEqual([
      { value: "xai", label: "xAI Grok" },
      { value: "codex", label: "OpenAI Codex" },
    ]);
    expect(api.laxProviderModels(reg)).toEqual({ xai: ["grok-4.5", "grok-4.3"], codex: ["gpt-5.5"] });
    expect(api.laxProviderLabels(reg)).toEqual({ xai: "xAI Grok", codex: "OpenAI Codex" });
    // Adapters must tolerate the empty/absent registry the callers pass on a
    // failed load rather than throwing inside a render.
    for (const adapter of [api.laxProviderOptions, api.laxProviderModels, api.laxProviderLabels]) {
      expect(() => adapter(null)).not.toThrow();
      expect(() => adapter(undefined)).not.toThrow();
    }
    // A provider with no models array must not produce undefined in the map.
    expect(api.laxProviderModels([{ id: "local", label: "Local Models" }])).toEqual({ local: [] });
  });

  it("no longer couples apps-ide.js to apps.js through a global", () => {
    // Executable source only — the replacement comment names the old globals to
    // explain what it stopped doing. `[^:]` keeps `https://` from reading as a
    // comment; split on \r?\n because the repo checks out CRLF.
    const code = stripComments(readFileSync(join(jsDir, "apps-ide.js"), "utf8"));
    expect(code.includes("APPS_PROVIDERS"), "must not read apps.js's provider global").toBe(false);
    expect(code.includes("APPS_MODELS"), "must not read apps.js's model global").toBe(false);
    expect(code).toContain("laxProviderRegistry()");
  });
});
