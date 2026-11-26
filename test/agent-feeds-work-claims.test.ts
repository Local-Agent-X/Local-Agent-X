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
let mine: unknown[] = [];
let ownCopy: unknown = null;
let orchestrator: unknown = null;
const apiFetch = vi.fn(async (_url: string, _init?: unknown) => ({ ok: true, json: async () => ({ holders: rows, mine, others, ownCopy, orchestrator }) }));

type Claims = {
  refreshWorkClaims: () => Promise<void>; workClaimsHtml: (r: unknown[]) => string;
  ownCopyAction: (a: string) => Promise<void>; orchestratorAction: (a: string) => Promise<void>;
  toggleAgentsPanel: (e?: unknown) => void; dismissAgentsClash: (what?: string) => void;
};
function load(): Claims {
  return new Function("esc", "apiFetch", "setInterval", `${claimsJs}
return { refreshWorkClaims, workClaimsHtml, ownCopyAction, orchestratorAction, toggleAgentsPanel, dismissAgentsClash };`)(esc, apiFetch, () => 0);
}

beforeEach(() => {
  document.body.innerHTML = `<div id="work-claims" style="display:none"></div><span id="other-agents-strip" style="display:none"></span><div id="agents-clash" style="display:none"></div>`;
  apiFetch.mockClear();
  others = [];
  ownCopy = null;
  orchestrator = null;
  (window as { activeChat?: unknown }).activeChat = null;
});

const strip = () => document.getElementById("other-agents-strip")!;
const banner = () => document.getElementById("agents-clash")!;
const buttons = (host: Element) => [...host.querySelectorAll("button")].map((b) => b.textContent);

// The chat window's strip: one pill in the toolbar's corner that opens a panel,
// and a banner only when another agent is in this chat's files or folder.
describe("the chat window's pill of the other agents in its project", () => {
  it("asks for this chat's project, counts the others in one pill and lists them in its panel", async () => {
    (window as { activeChat?: unknown }).activeChat = { id: "chat-me" };
    others = [
      { sessionId: "agent-1", kind: "worker", displayName: "Fix STT", task: "swap whisper", state: "active", areas: ["src/voice/stt.ts"], clashesWithMe: false },
      { sessionId: "chat-d", kind: "chat", displayName: "Docs", task: "", state: "idle", areas: [], clashesWithMe: false },
    ];
    const claims = load();
    await claims.refreshWorkClaims();
    expect(apiFetch.mock.calls[0][0]).toBe("/api/work-claims?session=chat-me");
    expect(strip().style.display).toBe("");
    const pill = strip().querySelector(".agents-pill")!;
    expect(pill.textContent).toContain("2 other agents here");
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    expect(strip().querySelector(".agents-panel")).toBeNull();
    expect(banner().style.display).toBe("none");

    claims.toggleAgentsPanel();
    const agents = [...strip().querySelectorAll(".agents-panel .other-agent")];
    expect(agents).toHaveLength(2);
    expect(agents[0].textContent).toContain("Fix STT");
    expect(agents[0].textContent).toContain("worker · working now");
    expect(agents[0].querySelector("code")?.textContent).toBe("src/voice/stt.ts");

    // A click anywhere else closes it.
    document.dispatchEvent(new Event("click"));
    expect(strip().querySelector(".agents-panel")).toBeNull();
    expect(strip().querySelector(".agents-pill")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("raises a banner only for an agent in this chat's files, until it is dismissed", async () => {
    (window as { activeChat?: unknown }).activeChat = { id: "chat-me" };
    others = [{ sessionId: "agent-1", displayName: "Fix STT", task: "", state: "active", areas: ["src/voice/stt.ts"], clashesWithMe: true }];
    const claims = load();
    await claims.refreshWorkClaims();
    expect(strip().querySelector(".agents-pill")!.className).toContain("clash");
    expect(banner().style.display).toBe("");
    expect(banner().textContent).toContain("Fix STT is changing the same files as this chat (src/voice/stt.ts).");
    expect(buttons(banner())).toEqual(["Details", "Dismiss"]);

    claims.dismissAgentsClash();
    expect(banner().style.display).toBe("none");
    await claims.refreshWorkClaims();
    expect(banner().style.display).toBe("none");

    // A different clash comes up again.
    others = [...others, { sessionId: "chat-x", displayName: "Other", task: "", state: "active", areas: ["a.ts"], clashesWithMe: true }];
    await claims.refreshWorkClaims();
    expect(banner().textContent).toContain("Fix STT, Other are changing");
  });

  it("offers the chat its own copy from the banner when another chat writes the same folder, and merges it back from the panel", async () => {
    (window as { activeChat?: unknown }).activeChat = { id: "chat-me" };
    ownCopy = { copy: null, sharesFolderWith: ["Voice chat"] };
    const claims = load();
    await claims.refreshWorkClaims();
    expect(banner().textContent).toContain("Same folder as Voice chat");
    expect(buttons(banner())).toEqual(["Work in own copy", "Dismiss"]);

    ownCopy = { copy: { branch: "chat/ab12", baseBranch: "main" }, sharesFolderWith: [] };
    await claims.ownCopyAction("start");
    expect(apiFetch.mock.calls.some((c) => c[0] === "/api/work-claims/own-copy" && JSON.parse((c[1] as { body: string }).body).action === "start")).toBe(true);
    expect(banner().textContent).toContain("This chat now works in its own copy.");
    expect(strip().querySelector(".agents-pill")!.textContent).toContain("Own copy");
    claims.toggleAgentsPanel();
    expect(strip().querySelector(".agents-panel")!.textContent).toContain("chat/ab12");
    expect(buttons(strip().querySelector(".agents-panel-controls")!)).toEqual(["Merge back", "Leave"]);
    claims.dismissAgentsClash("note");
    expect(banner().style.display).toBe("none");
  });

  it("lets a chat take the orchestrator role, set model preferences and release it", async () => {
    (window as { activeChat?: unknown }).activeChat = { id: "chat-me" };
    orchestrator = { available: true, mine: false, heldBy: null, routing: "" };
    const claims = load();
    await claims.refreshWorkClaims();
    // Alone in a repo: a quiet pill that holds the Orchestrate button.
    expect(strip().querySelector(".agents-pill")).not.toBeNull();
    claims.toggleAgentsPanel();
    expect(strip().querySelector(".agents-panel")!.textContent).toContain("No other agents here right now.");
    expect(buttons(strip().querySelector(".agents-panel-controls")!)[0]).toContain("Orchestrate");

    orchestrator = { available: true, mine: true, heldBy: null, routing: "Codex for UI" };
    await claims.orchestratorAction("take");
    const sent = apiFetch.mock.calls.find((c) => c[0] === "/api/work-claims/orchestrator");
    expect(JSON.parse((sent![1] as { body: string }).body)).toEqual({ action: "take", sessionId: "chat-me" });
    expect(strip().querySelector(".agents-pill")!.textContent).toContain("Orchestrator");
    expect(strip().querySelector(".orchestrator-badge")?.textContent).toContain("Orchestrator");
    expect(buttons(strip().querySelector(".agents-panel-controls")!)).toEqual(["Models", "Release"]);

    // Another chat sees who holds it, and no button to take it by accident.
    orchestrator = { available: true, mine: false, heldBy: "Lead chat", routing: "" };
    await claims.refreshWorkClaims();
    expect(strip().textContent).toContain("Orchestrator: Lead chat");
    expect(strip().querySelector(".agents-panel-controls button")).toBeNull();
  });

  it("is hidden when the chat works alone outside a repo", async () => {
    (window as { activeChat?: unknown }).activeChat = { id: "chat-me" };
    await load().refreshWorkClaims();
    expect(strip().style.display).toBe("none");
    expect(banner().style.display).toBe("none");
  });
});

describe("who is working on what", () => {
  // The strip listed every agent, a second row for each worker the list below
  // already shows (2026-11-25): now only the ones in the same files.
  it("lists only the agents in the same files, with their task and areas", async () => {
    rows = [
      { sessionId: "chat-a", kind: "chat", displayName: "Voice chat", task: "rework the pipeline", state: "active", folder: "local-agent-x", areas: ["src/voice/"], clashesWith: ["Fix STT"] },
      { sessionId: "agent-1", kind: "worker", displayName: "Fix STT", task: "swap whisper", state: "idle", folder: "wt-ab12", areas: ["src/voice/stt.ts"], clashesWith: ["Voice chat"] },
      { sessionId: "chat-c", kind: "chat", displayName: "Docs <b>", task: "", state: "idle", folder: "local-agent-x", areas: [], clashesWith: [] },
    ];
    await load().refreshWorkClaims();
    const host = document.getElementById("work-claims")!;
    expect(host.style.display).toBe("");
    const drawn = [...host.querySelectorAll(".work-claim-row")];
    expect(drawn).toHaveLength(2);
    expect(drawn[0].className).toContain("active");
    expect(drawn[0].textContent).toContain("Voice chat");
    expect(drawn[0].textContent).toContain("chat · working now · local-agent-x");
    expect(drawn[0].querySelector(".work-claim-areas code")?.textContent).toBe("src/voice/");
    expect(drawn[0].querySelector(".work-claim-clash")?.textContent).toContain("same files as Fix STT");
    expect(host.textContent).not.toContain("Docs");
  });

  it("is hidden when nobody shares files", async () => {
    rows = [{ sessionId: "chat-c", kind: "chat", displayName: "Docs <b>", task: "", state: "idle", folder: "local-agent-x", areas: [], clashesWith: [] }];
    await load().refreshWorkClaims();
    expect(document.getElementById("work-claims")!.style.display).toBe("none");
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

// With the panel's switch (chat-agent-feeds-scope.js) the strip lists the chat
// on screen: itself, the agents it started and the others in its project.
describe("the strip follows the panel's This chat / All chats switch", () => {
  const scopeJs = readFileSync(join(here, "../public/js/chat-agent-feeds-scope.js"), "utf8");
  const row = (sessionId: string, displayName: string) => ({ sessionId, kind: "chat", displayName, task: "", state: "active", folder: "repo", areas: [], clashesWith: ["someone"] });
  function loadScoped(): Claims & { setAgentFeedsScope: (s: string) => void } {
    return new Function("esc", "apiFetch", "setInterval", `var agentFeedsData = {}; ${scopeJs}
${claimsJs}
return { refreshWorkClaims, workClaimsHtml, ownCopyAction, orchestratorAction, toggleAgentsPanel, dismissAgentsClash, setAgentFeedsScope };`)(esc, apiFetch, () => 0);
  }
  const names = () => [...document.querySelectorAll("#work-claims .work-claim-name")].map((el) => el.textContent);

  it("lists this chat's own rows and its project's others once each; All lists every holder", async () => {
    localStorage.clear();
    (window as { activeChat?: unknown }).activeChat = { id: "chat-a" };
    rows = [row("chat-a", "Voice chat"), row("agent-1", "Fix STT"), row("chat-elsewhere", "Another project")];
    mine = [row("chat-a", "Voice chat"), row("agent-1", "Fix STT")];
    others = [row("agent-1", "Fix STT"), row("chat-c", "Docs")];
    const claims = loadScoped();
    await claims.refreshWorkClaims();
    expect(names()).toEqual(["Voice chat", "Fix STT", "Docs"]);
    claims.setAgentFeedsScope("all");
    expect(names()).toEqual(["Voice chat", "Fix STT", "Another project"]);
    localStorage.clear();
    mine = [];
  });
});
