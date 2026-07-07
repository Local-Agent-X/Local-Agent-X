// @vitest-environment happy-dom
//
// Regression tests for the ambient-card dead-end (field report 2026-07-06:
// clicking a cron/dream card in the AMBIENT dock did nothing — the card was
// header-only, so there was no path to the mission's output or report link,
// and updateAgentFeed's resultUrl write found no .agent-feed-result-link to
// fill). The fix gives ambient cards a fold body wired to the SAME selectors
// updateAgentFeed targets, an `ambient` marker class the header-click handler
// keys off, and render-time resultUrl markup via the shared resultLinkHtml
// chokepoint (also used by renderAgentCard so main cards stop dropping the
// link on full re-renders).
//
// Sources are classic browser globals — loaded via a Function factory like
// the sibling chat-agent-feeds-*.test.ts files.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

type Agent = Record<string, unknown>;
let renderAmbientCard: (agent: Agent, expanded?: boolean) => string;
let renderAmbientRegion: (ambient: Record<string, Agent>, expandedMap?: Record<string, unknown>) => string;
let renderAgentCard: (agent: Agent) => string;
let resultLinkHtml: (rawUrl: string) => string;

beforeAll(() => {
  const src =
    readFileSync(join(here, "../public/js/shared-escape.js"), "utf8") +
    "\n" +
    readFileSync(join(here, "../public/js/chat-agent-feeds-render.js"), "utf8") +
    "\n" +
    readFileSync(join(here, "../public/js/chat-agent-feeds-ambient.js"), "utf8");
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    src + "\nreturn { renderAmbientCard, renderAmbientRegion, renderAgentCard, resultLinkHtml };"
  );
  ({ renderAmbientCard, renderAmbientRegion, renderAgentCard, resultLinkHtml } = factory());
});

const cron: Agent = {
  id: "op-cron-1",
  name: "Worker: <scheduled_task> nightly research",
  type: "scheduled_mission",
  status: "working",
  output: "queued\nstarted\nsearching sources",
};

function toEl(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host.firstElementChild as HTMLElement;
}

describe("renderAmbientCard — fold body (the click dead-end regression)", () => {
  it("carries the updateAgentFeed live-write selectors (old header-only card had none)", () => {
    const el = toEl(renderAmbientCard(cron));
    // These three are the contract updateAgentFeed writes into; their absence
    // was the bug — progress and the finished mission's report link had
    // nowhere to land, so expanding/clicking could never show anything.
    expect(el.querySelector(".worker-latest")).not.toBeNull();
    expect(el.querySelector(".worker-tools-body")).not.toBeNull();
    expect(el.querySelector(".agent-feed-result-link")).not.toBeNull();
  });

  it("pre-fills the latest-line preview and full trace from agent.output", () => {
    const el = toEl(renderAmbientCard(cron));
    expect(el.querySelector(".worker-latest")!.textContent).toBe("searching sources");
    expect(el.querySelector(".worker-tools-body")!.textContent).toContain("queued");
  });

  it("marks the card `ambient` (header-click fold at any status keys off this)", () => {
    const el = toEl(renderAmbientCard(cron));
    expect(el.classList.contains("ambient")).toBe(true);
  });

  it("is folded by default, expanded when the caller says so", () => {
    expect(toEl(renderAmbientCard(cron)).classList.contains("folded")).toBe(true);
    expect(toEl(renderAmbientCard(cron, true)).classList.contains("folded")).toBe(false);
  });

  it("keeps the compact-dock contract: id, dismiss, ambient status word, dot", () => {
    const el = toEl(renderAmbientCard(cron));
    expect(el.id).toBe("agent-card-op-cron-1");
    expect(el.querySelector('[data-agent-action="dismiss"]')).not.toBeNull();
    expect(el.querySelector(".ambient-status")!.textContent).toContain("scanning");
    expect(el.querySelector(".agent-status-dot")).not.toBeNull();
  });

  it("renders the report link at render time when resultUrl is already known", () => {
    const el = toEl(renderAmbientCard({ ...cron, status: "completed", resultUrl: "/api/cron/j1/reports/latest" }));
    const link = el.querySelector(".agent-feed-result-link") as HTMLElement;
    expect(link.style.display).toBe("block");
    expect(link.querySelector("a")).not.toBeNull();
    expect(link.textContent).toContain("/api/cron/j1/reports/latest");
  });
});

describe("renderAmbientRegion — expanded state survives dock rebuilds", () => {
  it("expands exactly the ids in expandedMap", () => {
    const html = renderAmbientRegion({ a: { ...cron, id: "a" }, b: { ...cron, id: "b" } }, { a: 1 });
    const host = document.createElement("div");
    host.innerHTML = html;
    expect(host.querySelector("#agent-card-a")!.classList.contains("folded")).toBe(false);
    expect(host.querySelector("#agent-card-b")!.classList.contains("folded")).toBe(true);
  });
});

describe("resultLinkHtml — shared auth-append chokepoint", () => {
  it("appends ?token= to /api/ hrefs but keeps the visible label bare", () => {
    localStorage.setItem("lax_token", "sekret");
    const host = document.createElement("div");
    host.innerHTML = resultLinkHtml("/api/cron/j1/reports/latest");
    const a = host.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("/api/cron/j1/reports/latest?token=sekret");
    expect(a.textContent).not.toContain("sekret");
    localStorage.removeItem("lax_token");
  });

  it("leaves external URLs untouched", () => {
    localStorage.setItem("lax_token", "sekret");
    const host = document.createElement("div");
    host.innerHTML = resultLinkHtml("https://example.com/report");
    expect(host.querySelector("a")!.getAttribute("href")).toBe("https://example.com/report");
    localStorage.removeItem("lax_token");
  });
});

describe("renderAgentCard — main-card resultUrl now survives full re-renders", () => {
  it("renders the link at render time when the record carries resultUrl", () => {
    const el = toEl(renderAgentCard({ id: "op-9", name: "builder", status: "completed", resultUrl: "https://example.com/app" }));
    const link = el.querySelector(".agent-feed-result-link") as HTMLElement;
    expect(link.style.display).toBe("block");
    expect(link.textContent).toContain("https://example.com/app");
  });

  it("keeps the link container hidden when there is no resultUrl", () => {
    const el = toEl(renderAgentCard({ id: "op-9", name: "builder", status: "working" }));
    expect((el.querySelector(".agent-feed-result-link") as HTMLElement).style.display).toBe("none");
  });
});
