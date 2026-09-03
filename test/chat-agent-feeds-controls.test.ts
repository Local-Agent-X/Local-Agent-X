// @vitest-environment happy-dom
//
// renderAgentCardControls — the single owner of a worker card's control row.
//
// Two bugs sat here. (1) The markup was duplicated between renderAgentCard and
// updateAgentFeed's targeted rewrite, and the copies had already drifted: the
// rewrite dropped "Stay inline", so the button vanished the first time a card
// took a status update. (2) Controls rendered on FINISHED cards, and the
// redirect box beneath them accepted text, cleared itself and closed — a
// success-shaped animation for an instruction no worker could receive
// (opRedirect answers "not running" for a terminal op).
//
// Loaded via a Function factory like the sibling render specs, since the file
// is a browser global-script with no exports.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

let renderAgentCardControls: (safeId: string, status: unknown) => string;

beforeAll(() => {
  const src = readFileSync(join(here, "../public/js/chat-agent-feeds-render.js"), "utf8");
  // eslint-disable-next-line no-new-func
  const factory = new Function(src + "\nreturn { renderAgentCardControls };");
  renderAgentCardControls = factory().renderAgentCardControls;
});

const actionsIn = (html: string): string[] =>
  [...html.matchAll(/data-agent-action="([a-z]+)"/g)].map((m) => m[1]);

describe("renderAgentCardControls — terminal cards offer nothing", () => {
  it.each(["completed", "done", "succeeded", "failed", "cancelled", "error"])(
    "renders no controls for a %s worker",
    (status) => {
      expect(renderAgentCardControls("op_x", status)).toBe("");
    },
  );

  it("is case- and space-tolerant about terminal status, like isTerminalStatus", () => {
    expect(renderAgentCardControls("op_x", "  DONE ")).toBe("");
  });

  it("still offers the full row while a worker is live", () => {
    const actions = actionsIn(renderAgentCardControls("op_x", "working"));
    expect(actions).toEqual(["pause", "redirect", "stayinline", "cancel"]);
  });

  it("keeps Stay inline on a live card — the rewrite copy used to drop it", () => {
    expect(actionsIn(renderAgentCardControls("op_x", "working"))).toContain("stayinline");
  });
});

describe("renderAgentCardControls — pause/resume toggle", () => {
  it.each(["paused", "blocked", "stalled"])("offers Resume (not Pause) when %s", (status) => {
    const actions = actionsIn(renderAgentCardControls("op_x", status));
    expect(actions).toContain("resume");
    expect(actions).not.toContain("pause");
  });

  it("offers Pause while working", () => {
    const actions = actionsIn(renderAgentCardControls("op_x", "working"));
    expect(actions).toContain("pause");
    expect(actions).not.toContain("resume");
  });
});

describe("worker card control markup has exactly one owner", () => {
  it("neither render site hand-rolls its own control buttons", () => {
    // Both call sites must delegate. If a future edit inlines the markup
    // again, the terminal rule silently stops applying at that site.
    const render = readFileSync(join(here, "../public/js/chat-agent-feeds-render.js"), "utf8");
    const update = readFileSync(join(here, "../public/js/chat-agent-feeds.js"), "utf8");

    expect(update).toContain("renderAgentCardControls(");
    expect(update).not.toContain('data-agent-action="redirect"');
    // The render file defines the helper, so it legitimately contains the
    // markup once — inside that function and nowhere else.
    expect(render.match(/data-agent-action="redirect"/g) ?? []).toHaveLength(1);
  });
});
