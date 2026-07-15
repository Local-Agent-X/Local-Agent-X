import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Regression + contract test for install step severity.
//
// Live failure 2026-07-14, fresh Windows machine: winget's msstore source died
// with 0x8A15005E (server certificate did not match any of the expected
// values). That broke every winget call in the run. VS Build Tools — the
// HEAVIER dependency — caught it, warned, and continued. Ollama, an optional
// runtime, called fail() and killed the whole install with "Install manually
// from https://ollama.com/download". Same error, same run, opposite severity.
//
// The root cause wasn't the winget failure; it was that severity was a local
// judgment call at each call site, so it drifted. The fix makes `required` a
// declared property of each step in ALL_STEPS, and fail() consults it. These
// tests pin that structure — they read the installer as TEXT because it's an
// .mjs script with top-level side effects (it would run an install on import).
const SRC = readFileSync(
  fileURLToPath(new URL("../scripts/install-common.mjs", import.meta.url)),
  "utf-8",
);

// Parse `{ id: "x", label: "…", platforms: [...], required: true }` entries out
// of the ALL_STEPS literal.
function parseSteps(): Array<{ id: string; required: boolean | undefined }> {
  const block = SRC.match(/const ALL_STEPS = \[([\s\S]*?)\n\];/);
  if (!block) throw new Error("ALL_STEPS literal not found — did the installer's shape change?");
  return [...block[1].matchAll(/\{\s*id:\s*"([^"]+)"[\s\S]*?\}/g)].map((m) => ({
    id: m[1],
    required: /required:\s*true/.test(m[0]) ? true : /required:\s*false/.test(m[0]) ? false : undefined,
  }));
}

describe("install steps declare their own severity", () => {
  it("every step declares `required` — severity is never left implicit", () => {
    const undeclared = parseSteps().filter((s) => s.required === undefined);
    expect(undeclared.map((s) => s.id)).toEqual([]);
  });

  it("only true blockers are required — without these there is no app at all", () => {
    const required = parseSteps().filter((s) => s.required).map((s) => s.id).sort();
    // node/npm/build/config: no runtime without them. posixshell: the shell tool
    // (src/tools/shell-env.ts) assumes bash exists because this step guarantees
    // it — degrading would push the failure into the running app. desktop: a
    // missing electron.exe means the shortcut launches nothing.
    expect(required).toEqual(["build", "config", "desktop", "node", "npm", "posixshell"]);
  });

  it("optional runtimes are NOT required — the 2026-07-14 regression", () => {
    const byId = new Map(parseSteps().map((s) => [s.id, s.required]));
    // Ollama is the step that took down the install. The app runs fine without
    // it (cloud providers work; only semantic memory degrades).
    expect(byId.get("ollama")).toBe(false);
    // Its siblings: C++ toolchains are only needed for from-source native
    // builds — prebuilt binaries cover the normal case.
    expect(byId.get("vsbuildtools")).toBe(false);
    expect(byId.get("xcode-clt")).toBe(false);
    expect(byId.get("python")).toBe(false);
    expect(byId.get("embedmodel")).toBe(false);
  });
});

describe("fail() cannot abort an optional step", () => {
  it("consults the step's declared `required` before exiting", () => {
    const body = SRC.match(/const fail = \(m\) => \{([\s\S]*?)\n\};/);
    expect(body, "fail() not found").toBeTruthy();
    // The guard must read severity from the declaration, not decide locally.
    expect(body![1]).toMatch(/STEP_REQUIRED/);
    // …and must return early rather than reaching process.exit for optional steps.
    const guard = body![1].slice(0, body![1].indexOf("process.exit"));
    expect(guard).toMatch(/return;/);
  });

  it("records the shortfall so the app can offer repair", () => {
    expect(SRC).toMatch(/DEGRADED\.push/);
    expect(SRC).toMatch(/install-report\.json/);
  });
});

describe("winget calls skip the msstore source", () => {
  // 0x8A15005E came from msstore, and NONE of our packages live there — but
  // winget searches every configured source by default, so one broken source
  // failed installs that would otherwise have resolved fine.
  it("pins --source winget on every winget install", () => {
    // Match real invocations only — either the argv form `"winget", ["install"`
    // or the shell-string form `winget install …`. Prose in comments mentions
    // winget constantly and would otherwise trip this.
    const calls = [
      ...SRC.matchAll(/"winget",\s*\[\s*"install"[^\]]*\]/g),
      // The shell-string form spans several backtick-quoted lines joined with
      // `+`; consume through the last one so the source pin isn't missed.
      ...SRC.matchAll(/`winget install[\s\S]*?`(?:\s*\+\s*`[\s\S]*?`)*/g),
    ].map((m) => m[0]);
    // Guard the guard: if the shapes above stop matching, this test must fail
    // loudly rather than vacuously pass over an empty list.
    expect(calls.length, "no winget invocations matched — did the call shape change?").toBe(4);
    for (const call of calls) {
      expect(call, `winget install without a pinned source: ${call}`).toMatch(/WINGET_SOURCE|--source winget/);
    }
  });
});

describe("Ollama install exhausts every delivery path before giving up", () => {
  it("falls back to the direct installer when winget is present but broken", () => {
    const step = SRC.slice(SRC.indexOf('step("ollama")'), SRC.indexOf('stepDone("ollama")'));
    // The bug: installOllamaDirectWindows() existed but sat in the `else` of
    // `if (wingetAvailable())`, so a present-but-broken winget skipped it
    // entirely and went straight to a fatal error.
    const wingetBranch = step.slice(step.indexOf("if (wingetAvailable())"), step.indexOf("installOllamaDirectWindows"));
    expect(wingetBranch, "direct-install fallback is unreachable when winget fails").not.toMatch(/\bfail\(/);
    expect(step).toMatch(/installOllamaDirectWindows/);
  });
});
