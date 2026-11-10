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
let others: unknown[] = [];
let ownCopy: unknown = null;
let orchestrator: unknown = null;
const apiFetch = vi.fn(async (_url: string, _init?: unknown) => ({ ok: true, json: async () => ({ holders: rows, others, ownCopy, orchestrator }) }));

type Claims = {
  refreshWorkClaims: () => Promise<void>; workClaimsHtml: (r: unknown[]) => string;
  ownCopyAction: (a: string) => Promise<void>; orchestratorAction: (a: string) => Promise<void>;
};
function load(): Claims {
  return new Function("esc", "apiFetch", "setInterval", `${claimsJs}\nreturn { refreshWorkClaims, workClaimsHtml, ownCopyAction, orchestratorAction };`)(esc, apiFetch, () => 0);
}

beforeEach(() => {
  document.body.innerHTML = `<div id="work-claims" style="display:none"></div><span id="other-agents-strip" style="display:none"></span>`;
  apiFetch.mockClear();
  others = [];
  ownCopy = null;
  orchestrator = null;
  (window as { activeChat?: unknown }).activeChat = null;
});

describe("the chat window's strip of the other agents in its project", () => {
  it("asks for this chat's project and flags an agent in the same files", async () => {
    (window as { activeChat?: unknown }).activeChat = { id: "chat-me" };
    others = [
      { sessionId: "agent-1", displayName: "Fix STT", task: "swap whisper", state: "active", areas: ["src/voice/stt.ts"], clashesWithMe: true },
      { sessionId: "chat-d", displayName: "Docs", task: "", state: "idle", areas: [], clashesWithMe: false },
    ];
    await load().refreshWorkClaims();
    expect(apiFetch.mock.calls[0][0]).toBe("/api/work-claims?session=chat-me");
    const strip = document.getElementById("other-agents-strip")!;
    expect(strip.style.display).toBe("");
    expect(strip.textContent).toContain("Also working here:");
    const agents = [...strip.querySelectorAll(".other-agent")];
    expect(agents).toHaveLength(2);
    expect(agents[0].className).toContain("clash");
    expect(agents[0].textContent).toContain("Fix STT");
    expect(agents[0].querySelector("code")?.textContent).toBe("src/voice/stt.ts");
    expect(agents[1].querySelector(".other-agent-warn")).toBeNull();
  });

  it("offers the chat its own copy when another chat writes the same folder, and merges it back from there", async () => {
    (window as { activeChat?: unknown }).activeChat = { id: "chat-me" };
    ownCopy = { copy: null, sharesFolderWith: ["Voice chat"] };
    const claims = load();
    await claims.refreshWorkClaims();
    const strip = document.getElementById("other-agents-strip")!;
    expect(strip.textContent).toContain("Same folder as Voice chat");
    expect(strip.querySelector(".own-copy-btn")?.textContent).toBe("Work in own copy");

    ownCopy = { copy: { branch: "chat/ab12", baseBranch: "main" }, sharesFolderWith: [] };
    await claims.ownCopyAction("start");
    expect(apiFetch.mock.calls.some((c) => c[0] === "/api/work-claims/own-copy" && JSON.parse((c[1] as { body: string }).body).action === "start")).toBe(true);
    expect(strip.textContent).toContain("Own copy");
    expect(strip.textContent).toContain("chat/ab12");
    expect([...strip.querySelectorAll(".own-copy-btn")].map((b) => b.textContent)).toEqual(["Merge back", "Leave"]);
    expect(strip.textContent).toContain("This chat now works in its own copy.");
  });

  it("lets a chat take the orchestrator role, set model preferences and release it", async () => {
    (window as { activeChat?: unknown }).activeChat = { id: "chat-me" };
    orchestrator = { available: true, mine: false, heldBy: null, routing: "" };
    const claims = load();
    await claims.refreshWorkClaims();
    const strip = document.getElementById("other-agents-strip")!;
    expect(strip.querySelector(".own-copy-btn")?.textContent).toContain("Orchestrate");

    orchestrator = { available: true, mine: true, heldBy: null, routing: "Codex for UI" };
    await claims.orchestratorAction("take");
    const sent = apiFetch.mock.calls.find((c) => c[0] === "/api/work-claims/orchestrator");
    expect(JSON.parse((sent![1] as { body: string }).body)).toEqual({ action: "take", sessionId: "chat-me" });
    expect(strip.querySelector(".orchestrator-badge")?.textContent).toContain("Orchestrator");
    expect([...strip.querySelectorAll(".own-copy-btn")].map((b) => b.textContent)).toEqual(["Models", "Release"]);

    // Another chat sees who holds it, and no button to take it by accident.
    orchestrator = { available: true, mine: false, heldBy: "Lead chat", routing: "" };
    await claims.refreshWorkClaims();
    expect(strip.textContent).toContain("Orchestrator: Lead chat");
    expect(strip.querySelector(".own-copy-btn")).toBeNull();
  });

  it("is hidden when the chat works alone", async () => {
    (window as { activeChat?: unknown }).activeChat = { id: "chat-me" };
    await load().refreshWorkClaims();
    expect(document.getElementById("other-agents-strip")!.style.display).toBe("none");
  });
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
