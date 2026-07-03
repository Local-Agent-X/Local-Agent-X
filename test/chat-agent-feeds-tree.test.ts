// @vitest-environment happy-dom
//
// C6: unit tests for the PURE run-lineage tree builder in
// public/js/chat-agent-feeds-render.js (`buildAgentFeedTree`). The file is a
// classic browser global-script (no exports), so — matching the sibling
// agent-card-handlers.test.ts — we load its source in a Function factory
// and return the one pure function we need. buildAgentFeedTree takes the
// agentFeedsData map and returns the nested render-node tree; it touches no
// DOM, so it is fully testable this way.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

type Node =
  | { kind: "card"; id: string; children: Node[] }
  | { kind: "group"; parentOpId: string; count: number; children: Node[] };

let buildAgentFeedTree: (dataMap: Record<string, { parentOpId?: string }>) => Node[];

beforeAll(() => {
  // chat-agent-feeds-render.js is a pure-producers file (no top-level side
  // effects), so we can load it directly and lift out buildAgentFeedTree.
  const src = readFileSync(join(here, "../public/js/chat-agent-feeds-render.js"), "utf8");
  // eslint-disable-next-line no-new-func
  const factory = new Function(src + "\nreturn { buildAgentFeedTree };");
  ({ buildAgentFeedTree } = factory());
});

// Recursively collect every card id in render order, so we can assert each
// worker appears exactly once (never dropped, never doubled).
function collectCardIds(nodes: Node[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.kind === "card") out.push(n.id);
    out.push(...collectCardIds(n.children));
  }
  return out;
}

describe("buildAgentFeedTree (C6 run-lineage)", () => {
  it("(a) flat list when no parentOpId — every card is a top-level root, no groups", () => {
    const map = { a: {}, b: {}, c: {} };
    const nodes = buildAgentFeedTree(map);
    expect(nodes).toHaveLength(3);
    expect(nodes.every((n) => n.kind === "card")).toBe(true);
    expect(collectCardIds(nodes).sort()).toEqual(["a", "b", "c"]);
  });

  it("(b) N workers sharing a NON-card parent → one synthetic group of N", () => {
    const map = {
      w1: { parentOpId: "turn-1" },
      w2: { parentOpId: "turn-1" },
      w3: { parentOpId: "turn-1" },
    };
    const nodes = buildAgentFeedTree(map);
    expect(nodes).toHaveLength(1);
    const grp = nodes[0];
    expect(grp.kind).toBe("group");
    if (grp.kind === "group") {
      expect(grp.parentOpId).toBe("turn-1");
      expect(grp.count).toBe(3);
      expect(grp.children).toHaveLength(3);
    }
    expect(collectCardIds(nodes).sort()).toEqual(["w1", "w2", "w3"]);
  });

  it("(b2) a LONE worker with a non-card parent stays a plain root (no synthetic wrapper)", () => {
    const map = { solo: { parentOpId: "turn-1" } };
    const nodes = buildAgentFeedTree(map);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe("card");
    if (nodes[0].kind === "card") expect(nodes[0].id).toBe("solo");
  });

  it("(c) a worker whose parent IS a card nests under it", () => {
    const map = { parent: {}, child: { parentOpId: "parent" } };
    const nodes = buildAgentFeedTree(map);
    expect(nodes).toHaveLength(1);
    const root = nodes[0];
    expect(root.kind).toBe("card");
    if (root.kind === "card") {
      expect(root.id).toBe("parent");
      expect(root.children).toHaveLength(1);
      expect(root.children[0].kind).toBe("card");
      if (root.children[0].kind === "card") expect(root.children[0].id).toBe("child");
    }
    expect(collectCardIds(nodes).sort()).toEqual(["child", "parent"]);
  });

  it("(c2) mixed: a fan-out group AND an independent card-parent chain coexist", () => {
    const map = {
      w1: { parentOpId: "turn-1" },
      w2: { parentOpId: "turn-1" },
      root2: {},
      sub: { parentOpId: "root2" },
    };
    const nodes = buildAgentFeedTree(map);
    // one group (w1,w2) + one plain card root2 (with sub nested)
    expect(nodes.filter((n) => n.kind === "group")).toHaveLength(1);
    expect(collectCardIds(nodes).sort()).toEqual(["root2", "sub", "w1", "w2"]);
  });

  it("(d) a parentOpId cycle does not infinite-loop and every card appears exactly once", () => {
    // A→B→A: both are cards, so neither is a root. The leftover sweep must
    // still surface both, each rendered once (one nested under the other).
    const map = { A: { parentOpId: "B" }, B: { parentOpId: "A" } };
    const nodes = buildAgentFeedTree(map);
    const ids = collectCardIds(nodes);
    expect(ids.sort()).toEqual(["A", "B"]);
    // Exactly once each — no duplicates from the cycle.
    expect(ids).toHaveLength(2);
  });

  it("(d2) self-parent is treated as a root, rendered once", () => {
    const map = { x: { parentOpId: "x" } };
    const nodes = buildAgentFeedTree(map);
    expect(collectCardIds(nodes)).toEqual(["x"]);
  });

  it("handles empty / missing map without throwing", () => {
    expect(buildAgentFeedTree({})).toEqual([]);
    expect(buildAgentFeedTree(undefined as unknown as Record<string, never>)).toEqual([]);
  });
});
