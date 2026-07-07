// @vitest-environment happy-dom
//
// C8: unit tests for the two PURE helpers added to
// public/js/chat-agent-feeds-render.js —
//   • iconForType(type)     — per-agent-type / per-role icon lookup with a
//                             clean default (the "distinct icons" feature).
//   • isTerminalStatus(s)   — does a status put a card in a finished state
//                             (drives the fold-to-one-line "calm" feature).
// The file is a browser global-script (no exports / no top-level side effects),
// so — matching chat-agent-feeds-tree.test.ts / chat-agent-feeds-width.test.ts —
// we load its source in a Function factory and lift out the pure functions.
// These + syntax + build are the parts verifiable headlessly; the folded
// RENDERING and the actual glyphs on screen are visual and out of scope here.
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

let iconForType: (type: string | undefined) => string;
let isTerminalStatus: (status: unknown) => boolean;
let DEFAULT_AGENT_ICON: string;
let formatTokens: (n: unknown) => string;
let tokenBarFillPct: (n: unknown) => number;
type Rec = { type?: string };
let partitionAmbient: (m: Record<string, Rec> | undefined) => {
  ambient: Record<string, Rec>;
  main: Record<string, Rec>;
};

beforeAll(() => {
  // partitionAmbient moved to the -ambient sibling (400-LOC split); load both
  // sources in one scope, mirroring the classic-script global environment.
  const src =
    readFileSync(join(here, "../public/js/chat-agent-feeds-render.js"), "utf8") +
    "\n" +
    readFileSync(join(here, "../public/js/chat-agent-feeds-ambient.js"), "utf8");
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    src + "\nreturn { iconForType, isTerminalStatus, DEFAULT_AGENT_ICON, formatTokens, tokenBarFillPct, partitionAmbient };"
  );
  const m = factory();
  iconForType = m.iconForType;
  isTerminalStatus = m.isTerminalStatus;
  DEFAULT_AGENT_ICON = m.DEFAULT_AGENT_ICON;
  formatTokens = m.formatTokens;
  tokenBarFillPct = m.tokenBarFillPct;
  partitionAmbient = m.partitionAmbient;
});

describe("iconForType (C8 per-type icons)", () => {
  it("maps distinct op types to DISTINCT glyphs (the whole point)", () => {
    const icons = [
      iconForType("app_build"),
      iconForType("memory_consolidation"),
      iconForType("self_edit"),
      iconForType("refactor"),
      iconForType("freeform"),
      iconForType("scheduled_mission"),
    ];
    // All non-default and all different from one another.
    expect(icons.every((g) => g !== DEFAULT_AGENT_ICON)).toBe(true);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("gives the AMBIENT agents their distinct glyphs (dream = ☾, research/cron = ◎)", () => {
    // The whole ambient feature hinges on these two reading at a glance.
    expect(iconForType("memory_consolidation")).toBe("☾");
    expect(iconForType("scheduled_mission")).toBe("◎");
    // …and they're distinct from each other and never the generic fallback.
    expect(iconForType("memory_consolidation")).not.toBe(iconForType("scheduled_mission"));
    expect(iconForType("memory_consolidation")).not.toBe(DEFAULT_AGENT_ICON);
    expect(iconForType("scheduled_mission")).not.toBe(DEFAULT_AGENT_ICON);
  });

  it("build_app / app_builder alias app_build (model + server spellings) to the same glyph", () => {
    expect(iconForType("build_app")).toBe(iconForType("app_build"));
    // app_builder is the real opType the worker-runner emits — must not fall back.
    expect(iconForType("app_builder")).toBe(iconForType("app_build"));
    expect(iconForType("app_builder")).not.toBe(DEFAULT_AGENT_ICON);
  });

  it("still resolves legacy ROLE keys (inline specialist cards)", () => {
    expect(iconForType("coder")).toBe("💻");
    expect(iconForType("researcher")).toBe("🔍");
  });

  it("falls back to the generic default for unknown / absent keys", () => {
    expect(iconForType("totally_unknown_type")).toBe(DEFAULT_AGENT_ICON);
    expect(iconForType(undefined)).toBe(DEFAULT_AGENT_ICON);
    expect(iconForType("")).toBe(DEFAULT_AGENT_ICON);
  });

  it("gives the SUPERVISOR (orchestrator) a distinct glyph — never a worker/leaf icon", () => {
    const sup = iconForType("orchestrator");
    // Non-default, and NOT the same as any worker op-type or the leaf-agent glyph.
    expect(sup).not.toBe(DEFAULT_AGENT_ICON);
    const workerGlyphs = [
      iconForType("app_build"), iconForType("memory_consolidation"), iconForType("self_edit"),
      iconForType("refactor"), iconForType("freeform"), iconForType("scheduled_mission"),
      iconForType("agent"), iconForType("coder"),
    ];
    expect(workerGlyphs).not.toContain(sup);
  });

  it("aliases `supervisor` to the same glyph as `orchestrator`", () => {
    expect(iconForType("supervisor")).toBe(iconForType("orchestrator"));
  });
});

describe("partitionAmbient (background dream/cron dock split)", () => {
  it("routes dream (memory_consolidation) + research/cron (scheduled_mission) to AMBIENT", () => {
    const map = {
      dreamA: { type: "memory_consolidation" },
      cronB: { type: "scheduled_mission" },
    };
    const { ambient, main } = partitionAmbient(map);
    expect(Object.keys(ambient).sort()).toEqual(["cronB", "dreamA"]);
    expect(Object.keys(main)).toEqual([]);
  });

  it("keeps build / chat / orchestrator cards in MAIN (never ambient)", () => {
    const map = {
      w1: { type: "app_build" },
      w2: { type: "app_builder" },
      chat: { type: "agent" },
      orch: { type: "orchestrator" },
      edit: { type: "self_edit" },
      typeless: {}, // no type at all → main (the flat build/chat default)
    };
    const { ambient, main } = partitionAmbient(map);
    expect(Object.keys(ambient)).toEqual([]);
    expect(Object.keys(main).sort()).toEqual(
      ["chat", "edit", "orch", "typeless", "w1", "w2"].sort()
    );
  });

  it("splits a MIXED map disjointly — every record lands in exactly one bucket", () => {
    const map = {
      dream: { type: "memory_consolidation" },
      build: { type: "app_build" },
      cron: { type: "scheduled_mission" },
      orch: { type: "orchestrator" },
    };
    const { ambient, main } = partitionAmbient(map);
    expect(Object.keys(ambient).sort()).toEqual(["cron", "dream"]);
    expect(Object.keys(main).sort()).toEqual(["build", "orch"]);
    // Disjoint + total: union == input, no overlap, no drops.
    const union = [...Object.keys(ambient), ...Object.keys(main)].sort();
    expect(union).toEqual(Object.keys(map).sort());
    expect(Object.keys(ambient).some((k) => k in main)).toBe(false);
  });

  it("returns two empty buckets for an empty / missing map (never throws)", () => {
    expect(partitionAmbient({})).toEqual({ ambient: {}, main: {} });
    expect(partitionAmbient(undefined)).toEqual({ ambient: {}, main: {} });
  });
});

describe("formatTokens (Part B — token bar label)", () => {
  it("shows the bare integer under 1000", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1)).toBe("1");
    expect(formatTokens(999)).toBe("999");
  });

  it("shows one-decimal 'k' at or above 1000", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(12100)).toBe("12.1k");
    expect(formatTokens(50000)).toBe("50.0k");
  });

  it("is defensive about junk / negative input (never throws, never NaN)", () => {
    expect(formatTokens(undefined)).toBe("0");
    expect(formatTokens(null)).toBe("0");
    expect(formatTokens("nope")).toBe("0");
    expect(formatTokens(-5)).toBe("0");
  });
});

describe("tokenBarFillPct (Part B — token bar fill, soft-capped)", () => {
  it("is 0 for zero / non-positive / junk input", () => {
    expect(tokenBarFillPct(0)).toBe(0);
    expect(tokenBarFillPct(-100)).toBe(0);
    expect(tokenBarFillPct(undefined)).toBe(0);
    expect(tokenBarFillPct("nope")).toBe(0);
  });

  it("scales linearly against the 50k soft reference", () => {
    expect(tokenBarFillPct(25000)).toBeCloseTo(50, 5);
    expect(tokenBarFillPct(5000)).toBeCloseTo(10, 5);
  });

  it("saturates at 100 (a runaway op reads 'full', never overflows)", () => {
    expect(tokenBarFillPct(50000)).toBe(100);
    expect(tokenBarFillPct(500000)).toBe(100);
  });
});

describe("isTerminalStatus (C8 fold-finished-agents)", () => {
  it("is TRUE for every finished-state word in the card vocabulary", () => {
    for (const s of ["completed", "done", "succeeded", "failed", "cancelled", "error"]) {
      expect(isTerminalStatus(s)).toBe(true);
    }
  });

  it("is FALSE for in-flight states (never fold a running/waiting card)", () => {
    for (const s of ["working", "waiting", "paused", "queued", "running"]) {
      expect(isTerminalStatus(s)).toBe(false);
    }
  });

  it("does not treat a 'queued #3' badge as terminal (space/#-tolerant)", () => {
    expect(isTerminalStatus("queued #3")).toBe(false);
  });

  it("is case/whitespace tolerant", () => {
    expect(isTerminalStatus("  COMPLETED  ")).toBe(true);
    expect(isTerminalStatus("Failed")).toBe(true);
  });

  it("is FALSE for null / undefined / empty without throwing", () => {
    expect(isTerminalStatus(null)).toBe(false);
    expect(isTerminalStatus(undefined)).toBe(false);
    expect(isTerminalStatus("")).toBe(false);
  });
});
