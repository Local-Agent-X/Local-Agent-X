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
  getArchived: () => Array<{ name: string; archivedTs?: number }>;
  setMode: (v: string) => void;
  calls: string[];
}

function mountProtocolsUi(opts: { restoreFails?: boolean } = {}): Harness {
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
    // A failing unarchive is what exercises the optimistic rollback; everything
    // else (list, detail, archived) must still succeed or the render path under
    // test never runs.
    if (opts.restoreFails && url.includes("/unarchive")) {
      return Promise.resolve({
        ok: false, status: 409,
        json: () => Promise.resolve({ ok: false, error: "nope" }),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, protocols: [], archived: [], protocol: { name: "x", source: {} } }),
    });
  };

  // Load order mirrors app.html: shared helpers, then provenance (owns escAttr
  // and the authorship badges), then the archived module (protocols.js reads
  // archivedList/viewMode from it and calls protocolLoadArchived at load time).
  const sharedSrc = readFileSync(join(here, "../public/js/shared-escape.js"), "utf8");
  const provSrc = readFileSync(join(here, "../public/js/protocols-provenance.js"), "utf8");
  const archiveSrc = readFileSync(join(here, "../public/js/protocols-archive.js"), "utf8");
  const protoSrc = readFileSync(join(here, "../public/js/protocols.js"), "utf8");
  // eslint-disable-next-line no-new-func
  const factory = new Function("apiFetch", "navigate", "alert", `${sharedSrc}\n${provSrc}\n${archiveSrc}\n${protoSrc}\n` + `return {
    protocolRenderTree,
    setLive: v => { protocolList = v; },
    setArchived: v => { archivedList = v; },
    getArchived: () => archivedList,
    setMode: v => { viewMode = v; },
  };`);
  return { ...factory(apiFetch, () => {}, () => {}), calls } as Harness;
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
  const TS = 1_700_000_000_000;
  const archived = [{ name: BREAKOUT, description: "d", source: { type: "custom" }, archivedTs: TS, reason: "r" }];

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
    // The attribute is "<archivedTs>:<name>" — the archive is versioned, so the
    // name alone cannot say which card this is. The name still survives verbatim
    // after the first ':', including the breakout payload.
    expect(button.dataset.protoRestore).toBe(`${TS}:${BREAKOUT}`);
    button.click();
    await Promise.resolve();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
    expect(ui.calls).toContain(`/api/protocols/${encodeURIComponent(BREAKOUT)}/unarchive?archivedTs=${TS}`);
  });

  it("keeps a name containing ':' intact — the FIRST colon is the delimiter", async () => {
    const COLONS = "a:b::c";
    const ui = mountProtocolsUi();
    ui.setArchived([{ name: COLONS, description: "d", source: { type: "custom" }, archivedTs: TS }]);
    ui.setMode("archived");
    ui.protocolRenderTree();
    tree().querySelector<HTMLElement>("[data-proto-restore]")!.click();
    await Promise.resolve();
    expect(ui.calls).toContain(`/api/protocols/${encodeURIComponent(COLONS)}/unarchive?archivedTs=${TS}`);
  });
});

/**
 * The archive keeps every archived version of a name, discriminated by
 * archivedTs, and this view renders one card per record. Both halves of the
 * restore path have to respect that: the request must name the version the user
 * clicked, and the optimistic local update must drop only that row.
 */
describe("archived cards restore the version that was clicked", () => {
  const OLDER = 1_700_000_000_000;
  const NEWER = 1_700_000_999_999;
  const versions = () => [
    { name: "notes", description: "OLDER", source: { type: "custom" }, archivedTs: OLDER },
    { name: "notes", description: "NEWER", source: { type: "custom" }, archivedTs: NEWER },
  ];

  function mountWithVersions(opts: { restoreFails?: boolean } = {}): Harness {
    const ui = mountProtocolsUi(opts);
    ui.setArchived(versions());
    ui.setMode("archived");
    ui.protocolRenderTree();
    return ui;
  }

  /** Cards sort newest-first, so index 1 is the OLDER one. */
  function restoreButtons(): HTMLElement[] {
    return Array.from(tree().querySelectorAll<HTMLElement>("[data-proto-restore]"));
  }

  it("renders one card per version", () => {
    mountWithVersions();
    expect(restoreButtons()).toHaveLength(2);
  });

  it("clicking the OLDER card requests the OLDER stamp, not the newest", async () => {
    const ui = mountWithVersions();
    restoreButtons()[1].click();
    await Promise.resolve();
    expect(ui.calls).toContain(`/api/protocols/notes/unarchive?archivedTs=${OLDER}`);
    expect(ui.calls).not.toContain(`/api/protocols/notes/unarchive?archivedTs=${NEWER}`);
  });

  it("clicking the NEWER card requests the NEWER stamp", async () => {
    const ui = mountWithVersions();
    restoreButtons()[0].click();
    await Promise.resolve();
    expect(ui.calls).toContain(`/api/protocols/notes/unarchive?archivedTs=${NEWER}`);
    expect(ui.calls).not.toContain(`/api/protocols/notes/unarchive?archivedTs=${OLDER}`);
  });

  it("the optimistic update drops only the clicked version, not its siblings", () => {
    const ui = mountWithVersions();
    restoreButtons()[1].click();
    // Synchronous half of the optimistic update — asserted before the await
    // settles, which is exactly the window in which the sibling used to vanish.
    expect(ui.getArchived().map((r) => r.archivedTs)).toEqual([NEWER]);
    expect(restoreButtons()).toHaveLength(1);
  });

  it("rolls the full list back when the restore fails", async () => {
    const ui = mountWithVersions({ restoreFails: true });
    restoreButtons()[0].click();
    await new Promise((r) => setTimeout(r, 0));
    expect(ui.getArchived().map((r) => r.archivedTs).sort((a, b) => (a ?? 0) - (b ?? 0)))
      .toEqual([OLDER, NEWER]);
    expect(restoreButtons()).toHaveLength(2);
  });
});
