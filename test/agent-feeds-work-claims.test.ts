// @vitest-environment happy-dom
//
// The AGENTS tab's "working on" strip (ADR 0007 §4): one row per chat or
// worker in a project, with its task, the areas it is changing and a warning
// where two are in the same files. Drawn from GET /api/work-claims, redrawn on
// a work_claims_changed frame.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const claimsJs = readFileSync(join(here, "../public/js/chat-agent-feeds-claims.js"), "utf8");
const miscJs = readFileSync(join(here, "../public/js/chat-ws-handler-misc.js"), "utf8");

const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
let rows: unknown[] = [];
const apiFetch = vi.fn(async () => ({ ok: true, json: async () => ({ holders: rows }) }));

type Claims = { refreshWorkClaims: () => Promise<void>; workClaimsHtml: (r: unknown[]) => string };
function load(): Claims {
  return new Function("esc", "apiFetch", "setInterval", `${claimsJs}\nreturn { refreshWorkClaims, workClaimsHtml };`)(esc, apiFetch, () => 0);
}

beforeEach(() => {
  document.body.innerHTML = `<div id="work-claims" style="display:none"></div>`;
  apiFetch.mockClear();
});

describe("who is working on what", () => {
  it("shows each agent's task and areas, and flags the ones in the same files", async () => {
    rows = [
      { sessionId: "chat-a", kind: "chat", displayName: "Voice chat", task: "rework the pipeline", state: "active", folder: "local-agent-x", areas: ["src/voice/"], clashesWith: ["Fix STT"] },
      { sessionId: "agent-1", kind: "worker", displayName: "Fix STT", task: "swap whisper", state: "idle", folder: "wt-ab12", areas: ["src/voice/stt.ts"], clashesWith: ["Voice chat"] },
      { sessionId: "chat-c", kind: "chat", displayName: "Docs <b>", task: "", state: "recent", folder: "local-agent-x", areas: [], clashesWith: [] },
    ];
    await load().refreshWorkClaims();
    const host = document.getElementById("work-claims")!;
    expect(host.style.display).toBe("");
    const drawn = [...host.querySelectorAll(".work-claim-row")];
    expect(drawn).toHaveLength(3);
    expect(drawn[0].className).toContain("active");
    expect(drawn[0].textContent).toContain("Voice chat");
    expect(drawn[0].textContent).toContain("chat · working now · local-agent-x");
    expect(drawn[0].querySelector(".work-claim-areas code")?.textContent).toBe("src/voice/");
    expect(drawn[0].querySelector(".work-claim-clash")?.textContent).toContain("same files as Fix STT");
    expect(drawn[2].querySelector(".work-claim-clash")).toBeNull();
    expect(drawn[2].innerHTML).not.toContain("<b>");
  });

  it("hides the strip when nobody is working", async () => {
    rows = [];
    await load().refreshWorkClaims();
    expect(document.getElementById("work-claims")!.style.display).toBe("none");
  });

  it("re-reads when the server says a claim changed", () => {
    const refreshWorkClaims = vi.fn();
    const handleAgentFeedEvent = new Function("refreshWorkClaims", `${miscJs}\nreturn handleAgentFeedEvent;`)(refreshWorkClaims);
    handleAgentFeedEvent({ type: "work_claims_changed" });
    expect(refreshWorkClaims).toHaveBeenCalledTimes(1);
  });
});
