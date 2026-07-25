// @vitest-environment happy-dom
/**
 * The protocols tab renders cards for records whose `name` and `description` are
 * agent-authored and pass through no write-time validation — `POST /api/protocols`
 * accepts any string. An inline `onclick="protocolSelect('<name>')"` therefore puts
 * that string in an executable position, and HTML-entity escaping cannot save it:
 * the browser decodes attribute values BEFORE parsing the JS inside them.
 *
 * These tests pin the structural fix instead of an escaping trick — no `on*`
 * attribute is emitted at all, values ride in `data-*`, and a delegated listener
 * reads them back through `dataset`, where a payload can only ever be data.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// Two hostile names: one breaks out of a single-quoted JS string inside an
// attribute, the other closes the attribute itself.
const BREAKOUT = "x'); window.__pwned = 1; //";
const QUOTE_NAME = 'has"double"quotes';

interface Harness {
  protocolRenderTree: () => void;
  setLive: (v: unknown[]) => void;
  setArchived: (v: unknown[]) => void;
  setMode: (v: string) => void;
  calls: string[];
}

function mountProtocolsUi(): Harness {
  document.body.innerHTML = `
    <div id="protocols-list-view"></div>
    <div id="protocol-detail-wrap"></div>
    <span id="protocol-count"></span>
    <button id="protocol-archived-toggle"></button>
    <div id="protocol-tree"></div>
    <div id="protocol-view"></div>`;

  const calls: string[] = [];
  const apiFetch = (url: string) => {
    calls.push(url);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, protocols: [], archived: [], protocol: { name: "x", source: {} } }),
    });
  };

  // Load order mirrors app.html: the archived module first (protocols.js reads
  // archivedList/viewMode from it and calls protocolLoadArchived at load time).
  const archiveSrc = readFileSync(join(here, "../public/js/protocols-archive.js"), "utf8");
  const protoSrc = readFileSync(join(here, "../public/js/protocols.js"), "utf8");
  // eslint-disable-next-line no-new-func
  const factory = new Function("apiFetch", "navigate", `${archiveSrc}\n${protoSrc}\n` + `return {
    protocolRenderTree,
    setLive: v => { protocolList = v; },
    setArchived: v => { archivedList = v; },
    setMode: v => { viewMode = v; },
  };`);
  return { ...factory(apiFetch, () => {}), calls } as Harness;
}

function tree(): HTMLElement {
  return document.getElementById("protocol-tree")!;
}

beforeEach(() => {
  delete (window as unknown as Record<string, unknown>).__pwned;
});

describe("live protocol cards carry no executable name", () => {
  it("emits no on* handler attribute", () => {
    const ui = mountProtocolsUi();
    ui.setLive([{ name: BREAKOUT, description: "d", source: { type: "custom" }, tags: [] }]);
    ui.protocolRenderTree();
    expect(tree().innerHTML).not.toMatch(/\son\w+\s*=/i);
  });

  it("round-trips a breakout name through dataset, unmodified", () => {
    const ui = mountProtocolsUi();
    ui.setLive([{ name: BREAKOUT, description: "d", source: { type: "custom" }, tags: [] }]);
    ui.protocolRenderTree();
    const card = tree().querySelector<HTMLElement>("[data-proto-open]")!;
    expect(card).not.toBeNull();
    expect(card.dataset.protoOpen).toBe(BREAKOUT);
  });

  it("keeps a name containing double quotes inside its attribute", () => {
    const ui = mountProtocolsUi();
    ui.setLive([{ name: QUOTE_NAME, description: 'desc with "quotes"', source: { type: "custom" }, tags: [] }]);
    ui.protocolRenderTree();
    const cards = tree().querySelectorAll("[data-proto-open]");
    // One card, not a card plus whatever a prematurely-closed attribute spawned.
    expect(cards).toHaveLength(1);
    expect((cards[0] as HTMLElement).dataset.protoOpen).toBe(QUOTE_NAME);
  });

  it("opens the protocol on click without executing the payload", async () => {
    const ui = mountProtocolsUi();
    ui.setLive([{ name: BREAKOUT, description: "d", source: { type: "custom" }, tags: [] }]);
    ui.protocolRenderTree();
    tree().querySelector<HTMLElement>("[data-proto-open]")!.click();
    await Promise.resolve();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
    expect(ui.calls).toContain(`/api/protocols/${encodeURIComponent(BREAKOUT)}`);
  });
});

describe("archived protocol cards carry no executable name", () => {
  const archived = [{ name: BREAKOUT, description: "d", source: { type: "custom" }, archivedTs: 1_700_000_000_000, reason: "r" }];

  it("emits no on* handler attribute", () => {
    const ui = mountProtocolsUi();
    ui.setArchived(archived);
    ui.setMode("archived");
    ui.protocolRenderTree();
    expect(tree().innerHTML).not.toMatch(/\son\w+\s*=/i);
  });

  it("restores the exact archived name on click, executing nothing", async () => {
    const ui = mountProtocolsUi();
    ui.setArchived(archived);
    ui.setMode("archived");
    ui.protocolRenderTree();
    const button = tree().querySelector<HTMLElement>("[data-proto-restore]")!;
    expect(button.dataset.protoRestore).toBe(BREAKOUT);
    button.click();
    await Promise.resolve();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
    expect(ui.calls).toContain(`/api/protocols/${encodeURIComponent(BREAKOUT)}/unarchive`);
  });
});
