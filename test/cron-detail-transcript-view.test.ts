// @vitest-environment happy-dom
//
// Client half of the cron-transcript discovery path (see
// test/cron-run-transcript-link.test.ts for the server half).
//
// cron-detail.js is a classic browser global-script, so — like
// test/native-updater-ui.test.ts — its source is evaluated in a Function
// factory with the globals it reaches for passed in as parameters.
//
// What's pinned here:
//   • a run row links to its transcript ONLY when the record carries a
//     sessionId (a thrown/skipped run has none — no dead links),
//   • the link opens the transcript READ-ONLY through the same modal the
//     report viewer uses (one viewer, not two),
//   • it fetches the existing unfiltered GET /api/sessions/:id with ?view=raw
//     so the tool calls — the thing you open a cron transcript FOR — are there,
//   • it never routes through selectChat(), which would adopt the cron session
//     as a sidebar chat and undo e02c80f7's hiding.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../public/js/cron-detail.js"), "utf8");
// Drift gates below assert over CODE, not prose — the file's own comments name
// the very things (selectChat, /api/sessions/search) they must not call.
const code = source.replace(/^[ \t]*\/\/.*$/gm, "");

// Mirrors public/js/shared-escape.js esc() closely enough for assertions:
// HTML-escapes and, critically, escapes the quote characters that would let a
// value break out of the inline onclick attribute the row renders.
const esc = (value: unknown) => String(value == null ? "" : value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

type Json = Record<string, unknown>;

function load(responses: Record<string, Json>) {
  document.body.innerHTML = '<div id="cron-history"></div>';
  const apiJson = vi.fn(async (path: string) => {
    if (!(path in responses)) throw new Error(`unexpected fetch: ${path}`);
    return responses[path];
  });
  const alertFn = vi.fn();
  const factory = new Function("apiJson", "esc", "alert", `
    ${source}
    return { loadCronHistory, viewCronTranscript, cronTranscriptHtml };
  `);
  const api = factory(apiJson, esc, alertFn) as {
    loadCronHistory: (jobId: string) => Promise<void>;
    viewCronTranscript: (sessionId: string) => Promise<void>;
    cronTranscriptHtml: (session: Json) => string;
  };
  return { ...api, apiJson, alert: alertFn };
}

const HISTORY_PATH = "/api/cron/cron_abc/history?limit=20";
const SESSION_ID = "cron-cron_abc-1756900000000";

function run(overrides: Json = {}): Json {
  return {
    id: "run_1", jobId: "cron_abc", jobName: "nightly-scan",
    startedAt: "2026-09-02T06:00:00.000Z", durationMs: 240_000,
    status: "success", ...overrides,
  };
}

describe("cron run history rows — transcript link", () => {
  it("renders a transcript link for a run that recorded a session", async () => {
    const ui = load({ [HISTORY_PATH]: { runs: [run({ sessionId: SESSION_ID })] } });
    await ui.loadCronHistory("cron_abc");

    const link = document.querySelector("#cron-history [onclick^='viewCronTranscript']");
    expect(link).not.toBeNull();
    expect(link!.getAttribute("onclick")).toBe(`viewCronTranscript('${SESSION_ID}')`);
    expect(link!.textContent).toBe("transcript");
  });

  it("renders no link for runs with no recorded session (thrown / skipped)", async () => {
    const ui = load({
      [HISTORY_PATH]: {
        runs: [
          run({ id: "run_err", status: "error", errorMessage: "provider exploded" }),
          run({ id: "run_skip", status: "skipped", errorMessage: "previous run still active" }),
        ],
      },
    });
    await ui.loadCronHistory("cron_abc");

    expect(document.querySelectorAll("#cron-history [onclick^='viewCronTranscript']")).toHaveLength(0);
    // The rows themselves still render — losing the link must not lose the run.
    expect(document.getElementById("cron-history")!.textContent).toContain("provider exploded");
  });

  it("links one row and not the other when only some runs recorded a session", async () => {
    const ui = load({
      [HISTORY_PATH]: {
        runs: [run({ id: "run_2", sessionId: SESSION_ID }), run({ id: "run_1" })],
      },
    });
    await ui.loadCronHistory("cron_abc");

    expect(document.querySelectorAll("#cron-history [onclick^='viewCronTranscript']")).toHaveLength(1);
  });
});

describe("viewCronTranscript — read-only, through the existing viewer", () => {
  const session: Json = {
    id: SESSION_ID,
    messages: [
      { role: "user", content: "<scheduled_task>\nscan the thing\n</scheduled_task>" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "check the feed first" },
          { type: "text", text: "Fetching the feed." },
          { type: "tool_use", name: "web_fetch", input: { url: "https://example.com/feed" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", content: [{ type: "text", text: "200 OK — 12 entries" }] }] },
      { role: "assistant", content: [{ type: "text", text: "All clear." }] },
    ],
  };

  it("fetches the raw view of the existing session route and shows the intermediate steps", async () => {
    const path = `/api/sessions/${SESSION_ID}?view=raw`;
    const ui = load({ [path]: session });

    await ui.viewCronTranscript(SESSION_ID);

    expect(ui.apiJson).toHaveBeenCalledWith(path);
    const modal = document.querySelector("div[style*='fixed']");
    expect(modal).not.toBeNull();
    const text = modal!.textContent || "";
    // The tool call + its result are the whole point of opening a transcript.
    expect(text).toContain("web_fetch");
    expect(text).toContain("https://example.com/feed");
    expect(text).toContain("200 OK — 12 entries");
    expect(text).toContain("check the feed first");
    expect(text).toContain("All clear.");
    // Read-only: the only control is the shared modal's Close button.
    expect(modal!.querySelectorAll("button")).toHaveLength(1);
    expect(modal!.querySelectorAll("input, textarea, [contenteditable]")).toHaveLength(0);
  });

  it("escapes transcript content instead of rendering it as markup", async () => {
    const path = `/api/sessions/${SESSION_ID}?view=raw`;
    const ui = load({
      [path]: { messages: [{ role: "user", content: "<img src=x onerror=alert(1)>" }] },
    });

    await ui.viewCronTranscript(SESSION_ID);

    const modal = document.querySelector("div[style*='fixed']")!;
    expect(modal.querySelector("img")).toBeNull();
    expect(modal.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("says so plainly when the session has no messages", () => {
    const ui = load({});
    expect(ui.cronTranscriptHtml({ messages: [] })).toContain("No transcript saved for this run.");
    expect(ui.cronTranscriptHtml({ error: "Session not found" })).toContain("Session not found");
  });
});

describe("F6 invariant — the cron session stays out of the chat lists", () => {
  it("never routes a cron transcript through selectChat / the sidebar", () => {
    // selectChat (app-sidebar-actions.js) adopts an id as a sidebar chat, which
    // is exactly what e02c80f7 stopped search from doing with cron- ids. The
    // transcript link must stay an explicit read-only fetch.
    expect(code).not.toContain("selectChat");
    expect(code).not.toContain("setActiveSidebarSet");
  });

  it("asks for the transcript by id — it never lists or searches sessions", () => {
    expect(code).toContain("/api/sessions/${encodeURIComponent(sessionId)}?view=raw");
    expect(code).not.toContain("/api/sessions/search");
    expect(code).not.toMatch(/apiJson\(\s*['"`]\/api\/sessions['"`]/);
  });
});
