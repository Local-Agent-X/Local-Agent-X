// @vitest-environment happy-dom
//
// Regression: a 34-call tool loop looked frozen — the visible frame never
// changed while the agent worked. Three mechanisms stacked up:
//   • .activity-group-body is a fixed 320px scroller, so past ~5 cards every
//     new card lands below the fold;
//   • consecutive same-tool calls don't append a card at all — appendToolCardGrouped
//     edits "×3"→"×4" IN PLACE on a card that is already out of view;
//   • restoreActivityScroll only follows the tail while the reader is within
//     8px of the bottom, so a reader parked anywhere else stays parked (correct)
//     and therefore sees nothing at all (not correct).
//
// The fix leaves the parked position alone — force-scrolling a reader who
// deliberately scrolled up is its own bug — and moves the signal to the
// always-visible header line: the latest action's summary, a gear that advances
// one notch per action while work is in flight (so an identical repeat still
// MOVES) and parks on ✓ when the turn is done, plus a "↓ N new actions" badge
// counting what landed below the fold while the reader was parked.
//
// Everything here drives the REAL entry point — _renderAssistantToolArtifacts
// replaying the whole tool-event list into a fresh bubble, which is what every
// WS event does — so the header signal is asserted through the module that owns
// it (_updateActivityOutcome), not through a shortcut into the card builder.
//
// Loads the real browser IIFEs (classic script tags, not ES modules) into
// happy-dom the same way test/chat-render-window.test.ts does.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

type ToolArgs = Record<string, string>;
type ToolEvent = {
  type: "start" | "end";
  name: string;
  toolCallId: string;
  args?: ToolArgs;
  status?: string;
  result?: string;
};
type RenderData = { toolEvents: ToolEvent[]; stopNote?: { reason: string } };
type Artifacts = { _renderAssistantToolArtifacts: (body: HTMLElement, data: RenderData) => void };
type SavedScroll = { sel: string; key: string | null; i: number; top: number; atBottom: boolean };
type OpenState = {
  captureActivityScroll: (node: HTMLElement) => SavedScroll[];
  restoreActivityScroll: (node: HTMLElement, saved: SavedScroll[]) => void;
};

let artifacts: Artifacts;
let openState: OpenState;
const g = globalThis as unknown as Record<string, unknown>;

const load = <T>(file: string, ret: string): T => {
  const src = readFileSync(join(here, "../public/js/" + file), "utf8");
  // eslint-disable-next-line no-new-func
  return new Function(`${src}; return ${ret};`)() as T;
};

beforeEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  // esc lives in shared.js; the card markup is the only thing that needs it.
  g.esc = (s: unknown) => String(s ?? "");
  // _renderAssistantToolArtifacts swallows card-render throws into
  // console.error. Make that loud so a missing global can never read as a pass.
  console.error = (...a: unknown[]) => { throw new Error("render error: " + a.map(String).join(" ")); };
  // Script order in app.html: chat-tool-cards.js loads first and its helpers are
  // plain globals by the time chat-render-artifacts.js calls them.
  Object.assign(g, load<object>("chat-tool-cards.js", "{ appendToolCardGrouped, attachMediaPreview, toolSummary }"));
  artifacts = load<Artifacts>("chat-render-artifacts.js", "{ _renderAssistantToolArtifacts }");
  openState = load<OpenState>("chat-render-open-state.js", "{ captureActivityScroll, restoreActivityScroll }");
});

// One turn's worth of replayed tool events. Every call but the last has ended,
// so the turn is still in flight — the live case. `finished` ends them all.
function bashRun(commands: string[], opts: { finished?: boolean } = {}) {
  const evs: ToolEvent[] = commands.map((command, i) => ({
    type: "start", name: "bash", toolCallId: "c" + i, args: { command },
  }));
  const ended = opts.finished ? commands.length : commands.length - 1;
  for (let i = 0; i < ended; i++) {
    evs.push({ type: "end", name: "bash", toolCallId: "c" + i, status: "ok", result: "" });
  }
  return evs;
}

// One full bubble rebuild: the whole event list replayed into a fresh node,
// exactly as _buildLiveAssistantInto does on every WS event.
function paint(events: ToolEvent[], extra: Omit<RenderData, "toolEvents"> = {}) {
  const node = document.createElement("div");
  artifacts._renderAssistantToolArtifacts(node, { toolEvents: events, ...extra });
  const group = node.querySelector(".activity-group") as HTMLElement;
  expect(group).toBeTruthy();
  return { node, group, body: group.querySelector(".activity-group-body") as HTMLElement };
}

// happy-dom does no layout: hand the scroller the geometry of the real 320px
// box holding ~1000px of cards, and make scrollTop a plain settable property.
// clientHeight 0 is the real "no layout" frame — the Chat route hidden behind
// .page{display:none}, or the group collapsed.
function sizeBody(body: HTMLElement, scrollTop: number, clientHeight = 320) {
  Object.defineProperty(body, "clientHeight", { value: clientHeight, configurable: true });
  Object.defineProperty(body, "scrollHeight", { value: 1000, configurable: true });
  Object.defineProperty(body, "scrollTop", { value: scrollTop, writable: true, configurable: true });
}

// What preserveOpenState carries onto the fresh node before restoreActivityScroll
// runs (chat-render-live.js:113/119): the group the reader expanded.
const expand = (group: HTMLElement) => group.classList.add("open");

const latestText = (group: HTMLElement) => group.querySelector(".activity-latest-text") as HTMLElement | null;
const tick = (group: HTMLElement) => group.querySelector(".activity-tick") as HTMLElement | null;
const unseen = (group: HTMLElement) => group.querySelector(".activity-unseen") as HTMLElement | null;

describe("activity group — header signal during a long tool loop", () => {
  it("puts the CURRENT action in the header while every card sits below the fold", () => {
    const run = ["npm run build", "npm test", "git status", "rg todo", "node -v"];
    const five = paint(bashRun(run));
    // The mechanism under test: five consecutive bash calls collapse into ONE
    // card, so nothing new is appended for the reader to notice.
    expect(five.body.querySelectorAll(".tool-card")).toHaveLength(1);
    const text5 = latestText(five.group);
    expect(text5).toBeTruthy();
    expect(text5!.textContent).toContain("node -v");

    // Next event: same tool, different command. The card below the fold swaps
    // its summary; the header must swap with it.
    const six = paint(bashRun([...run, "npm ci"]));
    expect(latestText(six.group)!.textContent).toContain("npm ci");
    expect(latestText(six.group)!.textContent).not.toBe(text5!.textContent);
  });

  it("moves the header tick on a repeated IDENTICAL call, not just the ×N digit", () => {
    const two = paint(bashRun(["npm test", "npm test"]));
    const three = paint(bashRun(["npm test", "npm test", "npm test"]));

    expect(tick(two.group)).toBeTruthy();
    expect(tick(two.group)!.style.transform).not.toBe("");
    expect(tick(three.group)!.style.transform).not.toBe(tick(two.group)!.style.transform);

    // The card is still the same single in-place ×N edit, out of view.
    expect(three.body.querySelectorAll(".tool-card")).toHaveLength(1);
    expect((three.body.querySelector(".tool-count") as HTMLElement).textContent).toBe("×3");
    expect(latestText(three.group)!.textContent).toContain("×3");
  });

  // The header status line is owned by _updateActivityOutcome, which is the
  // only pass that has the END events: a card append cannot know whether the
  // call it just rendered has finished. Driving the line from the card builder
  // left every finished AND every reloaded turn spinning a gear forever.
  it("parks the tick once every call has ended, and repaints a reloaded turn identically", () => {
    const live = paint(bashRun(["npm test", "npm test"]));
    expect(tick(live.group)!.textContent).toBe("⚙");
    expect(tick(live.group)!.style.transform).not.toBe("");

    const done = paint(bashRun(["npm test", "npm test"], { finished: true }));
    expect(tick(done.group)!.textContent).toBe("✓");
    expect(tick(done.group)!.style.transform).toBe("");
    // It still says WHAT the agent last did — just not that it is still doing it.
    expect(latestText(done.group)!.textContent).toContain("npm test");

    // Stopping mid-bash leaves a start with no end forever. That turn is over
    // too — it is the ONE case where counting events alone would spin forever.
    const stopped = paint(bashRun(["npm test", "npm test"]), { stopNote: { reason: "Stopped." } });
    expect(tick(stopped.group)!.textContent).toBe("✓");
    expect(tick(stopped.group)!.style.transform).toBe("");

    // A reload replays the identical finished list: same paint, no drift.
    const reload = paint(bashRun(["npm test", "npm test"], { finished: true }));
    expect(reload.group.querySelector(".activity-latest")!.innerHTML)
      .toBe(done.group.querySelector(".activity-latest")!.innerHTML);
    expect(tick(reload.group)!.outerHTML).toBe(tick(done.group)!.outerHTML);
  });
});

describe("activity group — below-the-fold counter across the live swap", () => {
  const three = ["a", "b", "c"];
  const nine = [...three, "d", "e", "f", "g", "h", "i"];
  const twelve = [...nine, "j", "k", "l"];

  // Frames 1→2 establish "the reader is parked 120px down, caught up at N".
  function parkedAt(commands: string[]) {
    const f1 = paint(bashRun(commands));
    expand(f1.group);
    sizeBody(f1.body, 120);
    const saved1 = openState.captureActivityScroll(f1.node);
    const f2 = paint(bashRun(commands));
    expand(f2.group);
    sizeBody(f2.body, 0);
    openState.restoreActivityScroll(f2.node, saved1);
    return f2;
  }

  it("counts what landed below the fold without yanking a reader who scrolled up", () => {
    const f2 = parkedAt(three);
    expect(f2.body.scrollTop).toBe(120);
    expect(unseen(f2.group)).toBeTruthy();
    expect(unseen(f2.group)!.textContent).toBe("");

    // Six more calls land while the reader stays exactly where they parked.
    // They must NOT be scrolled, and they must be told.
    const saved2 = openState.captureActivityScroll(f2.node);
    const f3 = paint(bashRun(nine));
    expand(f3.group);
    sizeBody(f3.body, 0);
    openState.restoreActivityScroll(f3.node, saved2);

    expect(f3.body.scrollTop).toBe(120);
    expect(unseen(f3.group)!.style.display).not.toBe("none");
    // Counted in ACTIONS, and says so: the six calls deduped into ONE card, so
    // "↓ 6 new" over a single card would be pointing at something that isn't there.
    expect(f3.body.querySelectorAll(".tool-card")).toHaveLength(1);
    expect(unseen(f3.group)!.textContent).toBe("↓ 6 new actions");
  });

  it("keeps following the tail — and shows no badge — for a reader at the bottom", () => {
    const f1 = paint(bashRun(three));
    expand(f1.group);
    sizeBody(f1.body, 680); // 680 + 320 === 1000, inside the 8px bottom band
    const saved = openState.captureActivityScroll(f1.node);

    const f2 = paint(bashRun(nine));
    expand(f2.group);
    sizeBody(f2.body, 0);
    openState.restoreActivityScroll(f2.node, saved);

    expect(f2.body.scrollTop).toBe(1000);
    expect(unseen(f2.group)!.textContent).toBe("");
    expect(unseen(f2.group)!.style.display).toBe("none");
  });

  it("singular reads as one action", () => {
    const f2 = parkedAt(three);
    const saved = openState.captureActivityScroll(f2.node);
    const f3 = paint(bashRun([...three, "d"]));
    expand(f3.group);
    sizeBody(f3.body, 0);
    openState.restoreActivityScroll(f3.node, saved);
    expect(unseen(f3.group)!.textContent).toBe("↓ 1 new action");
  });

  // Taking the offer catches the reader up NOW. A finished turn has no next
  // frame to clear the badge — exactly when someone catches up on a long loop —
  // so a badge that only the next restore can clear is a permanent lie.
  it("clears the badge when the reader takes the jump offer", () => {
    const f2 = parkedAt(three);
    const saved = openState.captureActivityScroll(f2.node);
    const f3 = paint(bashRun(nine));
    expand(f3.group);
    sizeBody(f3.body, 0);
    openState.restoreActivityScroll(f3.node, saved);

    const badge = unseen(f3.group)!;
    expect(badge.textContent).toContain("6");
    badge.click();

    expect(f3.body.scrollTop).toBe(1000);
    expect(badge.textContent).toBe("");
    expect(badge.style.display).toBe("none");
  });

  // The carrier must survive a frame with no layout. .page{display:none} zeroes
  // clientHeight the moment the reader opens Apps/Settings while the agent
  // works, and _paintLiveSwap keeps swapping regardless. A carrier that lives on
  // the (discarded) node re-derives "fully seen" and tells the reader NOTHING
  // landed — silent, which is the worst way for this to fail.
  it("survives a frame with no layout while the reader is away", () => {
    const f2 = parkedAt(three);
    const saved2 = openState.captureActivityScroll(f2.node);

    // Reader opens another route: the bubble still repaints, with no layout.
    const f3 = paint(bashRun(nine));
    expand(f3.group);
    sizeBody(f3.body, 0, 0);
    openState.restoreActivityScroll(f3.node, saved2);
    expect(unseen(f3.group)!.textContent).toBe("↓ 6 new actions");

    // That frame captures nothing at all — the group is invisible.
    const saved3 = openState.captureActivityScroll(f3.node);
    expect(saved3.some(s => s.sel === ".activity-group-body")).toBe(false);

    // Back on Chat, three more calls deep: the count must still be cumulative.
    const f4 = paint(bashRun(twelve));
    expand(f4.group);
    sizeBody(f4.body, 0);
    openState.restoreActivityScroll(f4.node, saved3);
    expect(unseen(f4.group)!.textContent).toBe("↓ 9 new actions");
  });

  // `stream replace` (tool-call-from-text extraction) rewrites the bubble
  // mid-turn and can SHRINK the replayed list. An unclamped carry keeps a
  // stale-high "seen" and silently suppresses every later action.
  it("re-clamps the carry when a rebuild shrinks the replayed list", () => {
    const f1 = paint(bashRun(twelve));
    expand(f1.group);
    sizeBody(f1.body, 680); // caught up
    const saved1 = openState.captureActivityScroll(f1.node);

    const f2 = paint(bashRun(twelve));
    expand(f2.group);
    sizeBody(f2.body, 0);
    openState.restoreActivityScroll(f2.node, saved1);
    expect(f2.body.scrollTop).toBe(1000); // followed the tail: seen === 12
    f2.body.scrollTop = 120; // …and now the reader scrolls up to read
    const saved2 = openState.captureActivityScroll(f2.node);

    const shrunk = paint(bashRun(["a", "b"]));
    expand(shrunk.group);
    sizeBody(shrunk.body, 0);
    openState.restoreActivityScroll(shrunk.node, saved2);
    expect(unseen(shrunk.group)!.textContent).toBe("");

    // It grows again while the reader is still parked: that growth is unseen.
    const saved3 = openState.captureActivityScroll(shrunk.node);
    const regrown = paint(bashRun([...nine, "j", "k"]));
    expand(regrown.group);
    sizeBody(regrown.body, 0);
    openState.restoreActivityScroll(regrown.node, saved3);
    expect(unseen(regrown.group)!.textContent).toBe("↓ 9 new actions");
  });
});
