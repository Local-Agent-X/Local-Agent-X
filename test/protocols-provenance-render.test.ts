// @vitest-environment happy-dom
/**
 * Provenance rendering (public/js/protocols-provenance.js).
 *
 * Two invariants, both load-bearing for the recovery story that replaced a
 * user-confirmation gate on agent protocol writes:
 *
 * 1. FOUR states, and absent NEVER means "user". `authoredBy` and
 *    `lastEditedBy` are optional and absent on every protocol written before
 *    provenance existed, so treating absence as "the user wrote it" would
 *    credit the user with work the agent may have done. The fourth state —
 *    "you wrote it, the agent has since rewritten it" — exists because the
 *    review fork patches protocols it did not author and deliberately leaves
 *    `authoredBy` alone; `lastEditedBy` is the only trace.
 *
 * 2. `escAttr` is self-contained. Three files declare a global `esc()`
 *    (shared-escape.js, protocols.js, apps.js) and the last classic script in
 *    app.html wins, so an attribute escaper that called `esc()` would have its
 *    correctness decided by script order. These tests load a deliberately
 *    broken `esc()` LAST — exactly the position apps.js occupies — and assert
 *    escaping still holds.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const HOSTILE_NAME = 'x" onmouseover="window.__pwned=1" data-x="';
// The payload that separates "escapes quotes" from "escapes everything". The
// quotes arrive ALREADY entity-encoded, so a helper that only adds quote
// escaping has nothing to escape and emits `&quot;` verbatim. `&quot;` does not
// terminate an attribute value — attribute tokenization ends at a literal quote
// — so this is not an attribute breakout. What it corrupts is the VALUE: the
// parser decodes the entity, so `dataset.protoOpen` comes back holding a real
// `"` where the protocol's name has the six characters `&quot;`. The name that
// round-trips out of the DOM is then not the name that went in, and it is the
// string the click handler sends to the API. Escaping `&` first is what keeps
// the round-trip exact.
const ENTITY_NAME = 'x&quot; onmouseover=&quot;window.__pwned=1&quot; z';
const HOSTILE_TEXT = '</div><img src=x onerror="window.__pwned=1">';

interface Source {
  type?: string;
  authoredBy?: string;
  authoredAt?: number;
  authoredFromSession?: string;
  lastEditedBy?: string;
  lastEditedAt?: unknown;
  repo?: string;
}
interface Rec { name: string; description?: string; source?: Source; tags?: string[]; triggers?: string[] }

interface Harness {
  escAttr: (s: unknown) => string;
  protocolAuthorship: (p: unknown) => { key: string; label: string; agentEdited?: boolean; editedOn?: string };
  protocolSourceTag: (p: unknown) => string;
  protocolProvenanceParts: (p: unknown) => string[];
  protocolAgentNotice: (p: unknown) => string;
  protocolRenderDetail: () => void;
  protocolRenderTree: () => void;
  setRecord: (r: unknown) => void;
  setLive: (r: unknown[]) => void;
}

/**
 * @param sabotageEsc append a broken global `esc()` after every module, in the
 *   slot apps.js occupies in app.html. Anything that still escapes correctly
 *   under it owns its escaping; anything that stops escaping was borrowing.
 */
function mount(sabotageEsc = false): Harness {
  document.body.innerHTML = `
    <div id="protocols-list-view"></div>
    <div id="protocol-detail-wrap"></div>
    <span id="protocol-count"></span>
    <button id="protocol-archived-toggle"></button>
    <div id="protocol-tree"></div>
    <div id="protocol-view"></div>`;
  delete (window as unknown as Record<string, unknown>).__pwned;

  const read = (f: string) => readFileSync(join(here, "../public/js", f), "utf8");
  const src = [
    read("shared-escape.js"),
    read("protocols-provenance.js"),
    read("protocols-archive.js"),
    read("protocols.js"),
    // Identity escaper — the worst thing a foreign, load-order-selected esc()
    // could be. A later function declaration overwrites the binding for every
    // caller, which is precisely the F26 seam.
    sabotageEsc ? "function esc(s) { return String(s == null ? '' : s); }" : "",
  ].join("\n");

  // eslint-disable-next-line no-new-func
  const factory = new Function("apiFetch", "navigate", `${src}\nreturn {
    escAttr, protocolAuthorship, protocolSourceTag, protocolProvenanceParts,
    protocolAgentNotice, protocolRenderDetail, protocolRenderTree,
    setRecord: r => { selectedRecord = r; },
    setLive: r => { protocolList = r; },
  };`);
  const apiFetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  return factory(apiFetch, () => {}) as Harness;
}

const detailText = () => document.getElementById("protocol-view")!.textContent || "";

function renderDetail(ui: Harness, source: Source, extra: Partial<Rec> = {}) {
  ui.setRecord({ name: "p", description: "d", triggers: [], source, ...extra });
  ui.protocolRenderDetail();
}

describe("four provenance states", () => {
  it("agent-authored: names the agent and warns that nobody was asked", () => {
    const ui = mount();
    const a = ui.protocolAuthorship({ source: { authoredBy: "agent" } });
    expect(a.key).toBe("agent");
    expect(a.label).toBe("the agent, unprompted");
    expect(ui.protocolSourceTag({ source: { type: "custom", authoredBy: "agent" } })).toContain(">agent<");
    expect(ui.protocolAgentNotice({ source: { authoredBy: "agent" } })).toContain("wrote this itself");
  });

  it("user-authored and untouched: says you, and shows no agent badge or notice", () => {
    const ui = mount();
    const p = { source: { type: "custom", authoredBy: "user" } };
    expect(ui.protocolAuthorship(p)).toMatchObject({ key: "user", label: "you" });
    expect(ui.protocolSourceTag(p)).not.toContain("agent");
    expect(ui.protocolAgentNotice(p)).toBe("");
  });

  it("user-authored then agent-edited: keeps 'you' AND surfaces the rewrite as its own fact", () => {
    const ui = mount();
    const source: Source = {
      type: "custom", authoredBy: "user", authoredAt: Date.UTC(2026, 0, 2),
      lastEditedBy: "agent", lastEditedAt: Date.UTC(2026, 5, 9),
    };
    const a = ui.protocolAuthorship({ source });
    expect(a.key).toBe("user-agent-edited");
    expect(a.agentEdited).toBe(true);
    // Authorship is unchanged — the user really did write it — so the edit is a
    // SEPARATE statement, not a rewrite of "written by".
    expect(a.label).toBe("you");

    const parts = ui.protocolProvenanceParts({ source });
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain("written by: <strong>you</strong>");
    expect(parts[1]).toMatch(/changed since by: <strong>the agent<\/strong> on .+/);
    // The two dates must not collapse into one another.
    expect(parts[0]).not.toContain(new Date(source.lastEditedAt as number).toLocaleDateString());

    expect(ui.protocolSourceTag({ source })).toContain(">agent-edited<");
    expect(ui.protocolAgentNotice({ source })).toContain("rewrote this protocol");
  });

  it("absent provenance: renders 'not recorded' and never 'you'", () => {
    const ui = mount();
    const p = { source: { type: "custom" } };
    expect(ui.protocolAuthorship(p)).toMatchObject({ key: "unknown", label: "not recorded" });
    expect(ui.protocolProvenanceParts(p)[0]).toBe("written by: <strong>not recorded</strong>");
    expect(ui.protocolProvenanceParts(p)[0]).not.toContain("you");
    // Also for a record with no `source` at all, and for unrelated fields set.
    expect(ui.protocolAuthorship({}).label).toBe("not recorded");
    expect(ui.protocolAuthorship({ source: { type: "custom", authoredAt: 1 } }).label).toBe("not recorded");
    expect(ui.protocolAgentNotice(p)).toBe("");
  });

  it("absent author + agent edit: reports the edit without inventing an author", () => {
    const ui = mount();
    const source: Source = { type: "custom", lastEditedBy: "agent", lastEditedAt: Date.UTC(2026, 5, 9) };
    const a = ui.protocolAuthorship({ source });
    expect(a.key).toBe("unknown-agent-edited");
    expect(a.label).toBe("not recorded");
    expect(ui.protocolProvenanceParts({ source })[0]).not.toContain("you");
    expect(ui.protocolSourceTag({ source })).toContain(">agent-edited<");
  });

  it("a user edit is not an agent edit", () => {
    const ui = mount();
    const p = { source: { type: "custom", authoredBy: "user", lastEditedBy: "user", lastEditedAt: 1 } };
    expect(ui.protocolAuthorship(p).key).toBe("user");
    expect(ui.protocolSourceTag(p)).not.toContain("agent");
  });

  it("renders the edited state into the detail pane", () => {
    const ui = mount();
    renderDetail(ui, {
      type: "custom", authoredBy: "user", authoredAt: Date.UTC(2026, 0, 2),
      lastEditedBy: "agent", lastEditedAt: Date.UTC(2026, 5, 9),
    });
    expect(detailText()).toContain("written by: you");
    expect(detailText()).toContain("changed since by: the agent");
    expect(detailText()).toContain("rewrote this protocol");
  });

  it("renders the unknown state into the detail pane without claiming the user", () => {
    const ui = mount();
    renderDetail(ui, { type: "custom" });
    expect(detailText()).toContain("written by: not recorded");
    expect(detailText()).not.toContain("written by: you");
  });
});

describe("hostile fields cannot inject through provenance rendering", () => {
  it("keeps a quote-bearing name inside its data attribute, agent-edited badge and all", () => {
    const ui = mount();
    ui.setLive([{
      name: HOSTILE_NAME, description: HOSTILE_TEXT, tags: [],
      source: { type: "custom", authoredBy: "user", lastEditedBy: "agent", lastEditedAt: Date.UTC(2026, 5, 9) },
    }]);
    ui.protocolRenderTree();
    const tree = document.getElementById("protocol-tree")!;
    const cards = tree.querySelectorAll("[data-proto-open]");
    expect(cards).toHaveLength(1);
    expect((cards[0] as HTMLElement).dataset.protoOpen).toBe(HOSTILE_NAME);
    // Structural, not textual: the payload is allowed to APPEAR (escaped) in an
    // attribute value or a text node — what must not exist is an element that
    // actually carries a handler, or an element the payload created.
    expect(tree.querySelectorAll("[onmouseover],[onerror],[onload],[onclick]")).toHaveLength(0);
    expect(tree.querySelector("img")).toBeNull();
    expect(tree.textContent).toContain("agent-edited");
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });

  it("renders a hostile description, session id and lastEditedAt inert in the detail pane", () => {
    const ui = mount();
    renderDetail(ui, {
      type: "custom", authoredBy: "user", authoredFromSession: HOSTILE_TEXT,
      lastEditedBy: "agent", lastEditedAt: HOSTILE_TEXT,
    }, { name: HOSTILE_NAME, description: HOSTILE_TEXT });
    const view = document.getElementById("protocol-view")!;
    expect(view.querySelector("img")).toBeNull();
    // The action buttons carry static, argument-free onclick handlers; an
    // injected one would be a handler on some OTHER element or a handler whose
    // body is not one of those literals.
    expect(view.querySelectorAll("[onmouseover],[onerror],[onload]")).toHaveLength(0);
    for (const el of Array.from(view.querySelectorAll("[onclick]"))) {
      expect(el.getAttribute("onclick")).toMatch(/^protocol(StartEdit|Fork|Run|Archive|DeletePermanent)\(\)$/);
    }
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
    // A non-numeric timestamp must degrade to an inert string, not markup.
    expect(detailText()).toContain("changed since by: the agent");
  });

  // `category` and `source.type` are read straight off disk and index objects by
  // key. On a plain `{}` the key "__proto__" resolves to Object.prototype, which
  // is truthy — so the "not seen yet" guard never fires and `.push` throws. The
  // blast radius is the whole tab: one agent edit setting category to "__proto__"
  // renders zero cards and therefore zero provenance badges, disabling the only
  // surface where a user can see and undo agent work.
  it.each(["__proto__", "constructor", "toString"])("renders every card when a category is %s", (category) => {
    const ui = mount();
    ui.setLive([
      { name: "poisoned", description: "d", tags: [], category, source: { type: "custom", authoredBy: "agent" } },
      {
        name: "ordinary", description: "d", tags: [], category: "General",
        source: { type: "custom", authoredBy: "user", lastEditedBy: "agent", lastEditedAt: Date.UTC(2026, 5, 9) },
      },
    ] as unknown[]);
    expect(() => ui.protocolRenderTree()).not.toThrow();
    const tree = document.getElementById("protocol-tree")!;
    expect(tree.querySelectorAll("[data-proto-open]")).toHaveLength(2);
    // The badges are the point: they must survive the poisoned category.
    expect(tree.textContent).toContain("agent-edited");
    expect(tree.querySelectorAll(".proto-item-source")).toHaveLength(2);
  });

  it("renders when source.type is __proto__", () => {
    const ui = mount();
    ui.setLive([
      { name: "a", description: "d", tags: [], source: { type: "__proto__", authoredBy: "agent" } },
      { name: "b", description: "d", tags: [], source: { type: "custom", authoredBy: "user" } },
    ] as unknown[]);
    expect(() => ui.protocolRenderTree()).not.toThrow();
    expect(document.getElementById("protocol-tree")!.querySelectorAll("[data-proto-open]")).toHaveLength(2);
  });

  it("renders the detail pane when repo is not a string", () => {
    const ui = mount();
    // Typed `string`, but it arrives as JSON from disk. `.startsWith` on a number
    // throws, and protocolSelect's catch turns that into "Failed to load protocol"
    // — provenance included.
    renderDetail(ui, { type: "custom", authoredBy: "user", repo: 12345 as unknown as string });
    expect(detailText()).toContain("written by: you");
    expect(document.getElementById("protocol-view")!.querySelector("a")!.getAttribute("href"))
      .toBe("https://github.com/12345");
  });

  it("neutralises a repo value that is not an http(s) URL", () => {
    const ui = mount();
    // Pre-existing guard is `repo.startsWith('http')` — case-sensitive, and it
    // passes anything merely PREFIXED with "http". sanitizeUrl is the scheme
    // check, so the href must not carry the raw value.
    renderDetail(ui, { type: "custom", repo: "httpjavascript:alert(1)" });
    const a = document.getElementById("protocol-view")!.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("#");
    // A real slug still resolves.
    renderDetail(ui, { type: "custom", repo: "owner/repo" });
    expect(document.getElementById("protocol-view")!.querySelector("a")!.getAttribute("href"))
      .toBe("https://github.com/owner/repo");
  });
});

/**
 * The other half of the F26 seam. Three files declare a global `esc()` and
 * app.html loads apps.js LAST, so apps.js's body is the one every page module
 * actually runs — including ~40 attribute-position call sites (title=, alt=,
 * value=, data-*) across 16 files. It therefore has to be the strongest of the
 * three, not the weakest. These pin both halves of that: quotes are escaped
 * (attribute position is safe) AND nothing visible changes (text position
 * round-trips), which is the claim that made the change safe to land.
 */
describe("the global esc() that actually wins (apps.js)", () => {
  const PAYLOADS = [`a&b<c>d"e'f`, `plain text`, `"quoted"`, `it's`, `<img src=x onerror=alert(1)>`, `5 > 3 && 2 < 4`, `émoji 🙂`];

  function appsEsc(): (s: unknown) => string {
    const src = readFileSync(join(here, "../public/js/apps.js"), "utf8");
    // setInterval/window shadowed by parameters so loading the module has no
    // side effects — apps.js arms a 5s poller at top level.
    // eslint-disable-next-line no-new-func
    return new Function("setInterval", "window", `${src}\nreturn esc;`)(() => 0, {}) as (s: unknown) => string;
  }

  it("escapes both quote characters", () => {
    expect(appsEsc()(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&#39;f");
  });

  it.each(PAYLOADS)("keeps an attribute value intact: %s", (payload) => {
    document.body.innerHTML = `<div id="probe" title="${appsEsc()(payload)}"></div>`;
    expect(document.getElementById("probe")!.getAttribute("title")).toBe(payload);
  });

  it.each(PAYLOADS)("changes nothing visible in text position: %s", (payload) => {
    // The claim behind the change: entity-escaping quotes is invisible once
    // parsed, so no existing text-position caller renders differently.
    document.body.innerHTML = `<div id="probe">${appsEsc()(payload)}</div>`;
    const probe = document.getElementById("probe")!;
    expect(probe.textContent).toBe(payload);
    expect(probe.children).toHaveLength(0);
  });
});

describe("escAttr owns its escaping", () => {
  it("escapes markup and BOTH quote characters", () => {
    const ui = mount();
    expect(ui.escAttr(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&#39;f");
  });

  it("still escapes when a broken esc() wins the global binding", () => {
    // Same assertion, but a later script has replaced esc() with an identity
    // function — the apps.js slot. If escAttr borrowed esc(), this returns the
    // input unescaped and the attribute below breaks open.
    const ui = mount(true);
    expect(ui.escAttr(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&#39;f");
    expect(ui.protocolSourceTag({ source: { authoredBy: "agent" } })).not.toContain('""');
  });

  it.each([HOSTILE_NAME, ENTITY_NAME])("keeps a hostile name inside data-proto-open under a broken esc(): %s", (name) => {
    const ui = mount(true);
    ui.setLive([{ name, description: "d", tags: [], source: { type: "custom" } }]);
    ui.protocolRenderTree();
    const tree = document.getElementById("protocol-tree")!;
    const card = tree.querySelector<HTMLElement>("[data-proto-open]");
    expect(card).not.toBeNull();
    expect(card!.dataset.protoOpen).toBe(name);
    expect(tree.querySelectorAll("[onmouseover]")).toHaveLength(0);
  });
});
