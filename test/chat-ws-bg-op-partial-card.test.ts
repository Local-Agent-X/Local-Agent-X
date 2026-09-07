// @vitest-environment happy-dom
//
// A checkpoint-stopped op reaches the browser as bg_op_completed status
// `partial` (session-bridge-observer.ts). The chat card used to fall through
// its completed/failed ternary and label the op "cancelled" — telling the
// user someone had cancelled a worker nobody touched — and the OS toast said
// "Worker finished" for work that was not finished.
//
// The status TOKEN stays a bare word (`partial`): it is the card's CSS class
// (.agent-feed-card.partial, amber) and its terminal key (a finished op must
// fold and lose its pause/redirect/cancel controls). The human label
// "stopped (unfinished)" is derived from the token at render time, on both
// the initial render and updateAgentFeed's live status rewrite, so the two
// paths cannot disagree.
//
// Both files are classic browser global-scripts, evaluated in a Function
// factory with the globals they reach for passed in (the pattern of
// chat-ws-bg-op-completed-headless.test.ts and agent-card-handlers.test.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const bgSource = readFileSync(join(process.cwd(), "public/js/chat-ws-handler-bg-ops.js"), "utf8");
const escSource = readFileSync(join(process.cwd(), "public/js/shared-escape.js"), "utf8");
const renderSource = readFileSync(join(process.cwd(), "public/js/chat-agent-feeds-render.js"), "utf8");
const feedsSource = readFileSync(join(process.cwd(), "public/js/chat-agent-feeds.js"), "utf8");

function loadBgOps() {
  const addAgentFeed = vi.fn();
  const updateAgentFeed = vi.fn();
  const showNotification = vi.fn();
  const factory = new Function(
    "addAgentFeed", "updateAgentFeed", "removeAgentFeed", "setTimeout", "showNotification",
    `
    var window = { desktop: { showNotification: showNotification } };
    var activeChat = null;
    var ChatStreamStore = { setSidebarActive: function() {} };
    var renderSidebar = function() {};
    var agentFeedsData = {};
    ${bgSource}
    return { dispatchBgOpEventChecked: dispatchBgOpEventChecked, bgOpCardStatus: bgOpCardStatus, bgOpToastTitle: bgOpToastTitle };
    `,
  );
  const api = factory(addAgentFeed, updateAgentFeed, vi.fn(), vi.fn(), showNotification) as {
    dispatchBgOpEventChecked: (msg: unknown) => boolean | null;
    bgOpCardStatus: (status: unknown) => string;
    bgOpToastTitle: (status: unknown) => string;
  };
  return { ...api, addAgentFeed, updateAgentFeed, showNotification };
}

function loadRender() {
  // eslint-disable-next-line no-new-func
  const factory = new Function(escSource + "\n" + renderSource + "\nreturn { renderAgentCard, agentStatusLabel, isTerminalStatus };");
  return factory() as {
    renderAgentCard: (agent: Record<string, unknown>) => string;
    agentStatusLabel: (status: string) => string;
    isTerminalStatus: (status: unknown) => boolean;
  };
}

const completed = (status: string) => ({
  sessionId: "chat-1",
  event: { type: "bg_op_completed", opId: "op-p", status, summary: "PARTIAL — child op op-p stopped at a checkpoint", filesChanged: [] },
});

describe("bg_op_completed status partial — the chat card says stopped (unfinished), never cancelled", () => {
  it("maps every terminal status to its card token; partial is its own token, unknown falls to cancelled", () => {
    const h = loadBgOps();
    expect(h.bgOpCardStatus("completed")).toBe("completed");
    expect(h.bgOpCardStatus("failed")).toBe("failed");
    expect(h.bgOpCardStatus("partial")).toBe("partial");
    expect(h.bgOpCardStatus("cancelled")).toBe("cancelled");
    expect(h.bgOpCardStatus("bogus")).toBe("cancelled");
  });

  it("a partial completion flips the card to `partial` and toasts 'Worker stopped (unfinished)'", () => {
    const h = loadBgOps();
    expect(h.dispatchBgOpEventChecked(completed("partial"))).toBe(true);
    expect(h.addAgentFeed).toHaveBeenCalledWith(expect.objectContaining({ id: "op-p", status: "partial" }));
    expect(h.updateAgentFeed).toHaveBeenCalledWith("op-p", {
      status: "partial",
      output: "PARTIAL — child op op-p stopped at a checkpoint",
    });
    expect(h.showNotification).toHaveBeenCalledWith("Worker stopped (unfinished)", "PARTIAL — child op op-p stopped at a checkpoint");
  });

  it("the other terminal statuses keep the 'Worker finished' toast", () => {
    const h = loadBgOps();
    for (const status of ["completed", "failed", "cancelled"]) expect(h.bgOpToastTitle(status)).toBe("Worker finished");
    expect(h.bgOpToastTitle("partial")).toBe("Worker stopped (unfinished)");
  });
});

describe("agent card — the partial token renders as a terminal, amber-classed card labelled stopped (unfinished)", () => {
  it("agentStatusLabel: the four terminal labels", () => {
    const r = loadRender();
    expect(r.agentStatusLabel("completed")).toBe("completed");
    expect(r.agentStatusLabel("failed")).toBe("failed");
    expect(r.agentStatusLabel("cancelled")).toBe("cancelled");
    expect(r.agentStatusLabel("partial")).toBe("stopped (unfinished)");
  });

  it("partial is terminal: the card folds, carries the .partial class, shows the label and no live controls", () => {
    const r = loadRender();
    expect(r.isTerminalStatus("partial")).toBe(true);
    const html = r.renderAgentCard({ id: "op-p", name: "Worker: op-p", status: "partial", output: "" });
    expect(html).toContain('class="agent-feed-card partial folded"');
    expect(html).toContain('data-terminal="1"');
    expect(html).toContain("stopped (unfinished)");
    expect(html).not.toContain(">partial<");
    for (const action of ["pause", "redirect", "cancel"]) expect(html).not.toContain(`data-agent-action="${action}"`);
  });

  it("the live status rewrite in updateAgentFeed goes through the same label", () => {
    // chat-agent-feeds.js reaches for the render file's helpers at call time;
    // feed it the real render source and a real DOM card, then flip the status.
    document.body.innerHTML = "";
    // agentFeedsData / agentFeedsOpen / agentFeedsAutoOpen live in the autoopen
    // sibling, isAmbientType in the ambient one; the card record is seeded
    // directly so the targeted-rewrite path (card exists) is what runs.
    const factory = new Function(
      "document",
      "var agentFeedsData = {}; var agentFeedsOpen = false; var agentFeedsAutoOpen = false;\n"
        + "function isAmbientType() { return false; }\n"
        + escSource + "\n" + renderSource + "\n" + feedsSource
        + "\nreturn { updateAgentFeed, renderAgentCard, agentFeedsData };",
    );
    const api = factory(document) as {
      updateAgentFeed: (id: string, u: Record<string, unknown>) => void;
      renderAgentCard: (a: Record<string, unknown>) => string;
      agentFeedsData: Record<string, Record<string, unknown>>;
    };
    const live = { id: "op-live", name: "Worker: op-live", status: "working", output: "" };
    api.agentFeedsData["op-live"] = live;
    document.body.innerHTML = api.renderAgentCard(live);
    api.updateAgentFeed("op-live", { status: "partial", output: "PARTIAL — stopped" });
    const card = document.getElementById("agent-card-op-live")!;
    expect(card.className).toContain("agent-feed-card partial");
    expect(card.getAttribute("data-terminal")).toBe("1");
    expect(card.querySelector(".agent-feed-status")!.textContent).toContain("stopped (unfinished)");
  });
});

describe("the CSS carries a partial rule distinct from failed and cancelled", () => {
  it(".agent-feed-card.partial is amber (var(--warn)), not danger or muted", () => {
    const css = readFileSync(join(process.cwd(), "public/css/app.css"), "utf8");
    expect(css).toMatch(/\.agent-feed-card\.partial\{border-left-color:var\(--warn\)/);
    expect(css).toMatch(/\.agent-feed-card\.partial \.agent-status-dot\{background:var\(--warn\)/);
  });
});
