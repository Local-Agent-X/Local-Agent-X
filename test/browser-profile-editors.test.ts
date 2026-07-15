// @vitest-environment happy-dom
//
// Wires the per-editor "Browser profile" <select>s (P2). The template editor
// (public/js/agents/templates.js) and the mission/cron editor
// (public/js/cron-detail.js) each grow a profile picker populated from
// GET /api/browser/profiles; selecting a profile saves its id, "(inherit)"
// clears it. Both source files are loaded verbatim and exercised in happy-dom,
// so the test breaks if the wiring regresses.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const g = globalThis as Record<string, unknown>;

const PROFILES = [
  { id: "p1", name: "Work" },
  { id: "p2", name: "Personal" },
];

afterEach(() => {
  document.body.innerHTML = "";
  for (const k of ["esc", "state", "openAgentForm", "closeAgentDetail", "loadTeam", "API", "AUTH_TOKEN", "fetch", "apiJson", "selectedJob", "cronJobs", "alert"]) {
    delete g[k];
  }
});

// ── Template editor ─────────────────────────────────────────────────────────
describe("agent template editor — browser profile picker", () => {
  let lastBody: Record<string, unknown> | null;

  function loadTemplatesModule() {
    // templates.js is an ES module; strip the import/export machinery so the
    // functions land as locals in a Function scope, then hand back the two we
    // exercise. Everything the module reads as a free variable (esc, state,
    // API, AUTH_TOKEN, fetch, alert) resolves off globalThis.
    const raw = readFileSync(join(here, "../public/js/agents/templates.js"), "utf8");
    const src = raw
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("import "))
      .join("\n")
      .replace(/^export /gm, "");
    return new Function(`${src}\n; return { showTemplateForm, saveTemplate };`)() as {
      showTemplateForm(existing?: unknown): Promise<void>;
      saveTemplate(existingId?: string): Promise<void>;
    };
  }

  beforeEach(() => {
    lastBody = null;
    document.body.innerHTML = `<div id="agents-template-form"></div>`;
    g.esc = (s: unknown) => String(s ?? "");
    g.state = { currentProject: null };
    g.openAgentForm = () => {};
    g.closeAgentDetail = () => {};
    g.loadTeam = () => {};
    g.API = "";
    g.AUTH_TOKEN = "tok";
    g.alert = () => {};
    g.fetch = async (url: string, opts?: { method?: string; body?: string }) => {
      if (url.includes("/api/browser/profiles")) return { ok: true, json: async () => PROFILES } as Response;
      if (url.includes("/api/agents/hired")) return { ok: true, json: async () => [] } as Response;
      if (url.includes("/api/agents/templates")) {
        if (opts?.body) lastBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    };
  });

  it("renders one option per profile plus (inherit), with the saved id selected", async () => {
    const m = loadTemplatesModule();
    await m.showTemplateForm({ id: "t1", name: "X", role: "r", description: "", systemPrompt: "", allowedTools: [], defaultBrowserProfileId: "p2" });
    const sel = document.getElementById("tpl-browser-profile") as HTMLSelectElement;
    expect(sel).toBeTruthy();
    const opts = Array.from(sel.options).map((o) => o.value);
    expect(opts).toEqual(["", "p1", "p2"]);
    expect(sel.options[0].textContent).toBe("(inherit)");
    const selected = Array.from(sel.options).find((o) => o.hasAttribute("selected"));
    expect(selected?.value).toBe("p2");
  });

  it("saves the selected profile id", async () => {
    const m = loadTemplatesModule();
    await m.showTemplateForm({ id: "t1", name: "X", role: "r", description: "", systemPrompt: "", allowedTools: [], defaultBrowserProfileId: "" });
    (document.getElementById("tpl-browser-profile") as HTMLSelectElement).value = "p1";
    await m.saveTemplate("t1");
    expect(lastBody).toBeTruthy();
    expect(lastBody!.defaultBrowserProfileId).toBe("p1");
  });

  it("(inherit) sends a falsy profile id so the pin clears", async () => {
    const m = loadTemplatesModule();
    await m.showTemplateForm({ id: "t1", name: "X", role: "r", description: "", systemPrompt: "", allowedTools: [], defaultBrowserProfileId: "p1" });
    (document.getElementById("tpl-browser-profile") as HTMLSelectElement).value = "";
    await m.saveTemplate("t1");
    expect(lastBody).toBeTruthy();
    expect(lastBody!.defaultBrowserProfileId).toBeFalsy();
  });
});

// ── Cron / mission editor ───────────────────────────────────────────────────
describe("mission (cron) editor — browser profile picker", () => {
  let lastPatch: Record<string, unknown> | null;

  function loadCronModule() {
    // cron-detail.js is a plain (non-module) script — its top-level functions
    // become Function-scope locals; free variables (esc, apiJson, selectedJob,
    // cronJobs) resolve off globalThis.
    const src = readFileSync(join(here, "../public/js/cron-detail.js"), "utf8");
    return new Function(`${src}\n; return { loadMissionProfileOptions, renderMissionProfilePicker, setMissionProfile };`)() as {
      loadMissionProfileOptions(): Promise<unknown>;
      renderMissionProfilePicker(job: unknown): void;
      setMissionProfile(value: string): Promise<void>;
    };
  }

  beforeEach(() => {
    lastPatch = null;
    document.body.innerHTML = `<select id="cron-detail-profile"></select>`;
    g.esc = (s: unknown) => String(s ?? "");
    g.selectedJob = { id: "j1", browserProfileId: "p2" };
    g.cronJobs = [{ id: "j1", browserProfileId: "p2" }];
    g.apiJson = async (path: string, opts?: { body?: string }) => {
      if (path === "/api/browser/profiles") return PROFILES;
      if (path.startsWith("/api/cron/")) {
        lastPatch = opts?.body ? JSON.parse(opts.body) : null;
        return { ok: true, job: { id: "j1", browserProfileId: lastPatch?.browserProfileId } };
      }
      return {};
    };
  });

  it("renders one option per profile plus (inherit), with the saved id selected", async () => {
    const m = loadCronModule();
    await m.loadMissionProfileOptions();
    m.renderMissionProfilePicker(g.selectedJob);
    const sel = document.getElementById("cron-detail-profile") as HTMLSelectElement;
    const opts = Array.from(sel.options).map((o) => o.value);
    expect(opts).toEqual(["", "p1", "p2"]);
    expect(sel.options[0].textContent).toBe("(inherit)");
    // happy-dom doesn't sync <select>.value from a `selected` attribute when
    // innerHTML is assigned directly on the <select> (the picker's pattern,
    // honored by real browsers), so assert the attribute the render emits.
    const selected = Array.from(sel.options).find((o) => o.hasAttribute("selected"));
    expect(selected?.value).toBe("p2");
  });

  it("PATCHes the selected profile id", async () => {
    const m = loadCronModule();
    await m.setMissionProfile("p1");
    expect(lastPatch).toBeTruthy();
    expect(lastPatch!.browserProfileId).toBe("p1");
  });

  it("(inherit) PATCHes a falsy profile id so the pin clears", async () => {
    const m = loadCronModule();
    await m.setMissionProfile("");
    expect(lastPatch).toBeTruthy();
    expect(lastPatch!.browserProfileId).toBeFalsy();
  });
});
