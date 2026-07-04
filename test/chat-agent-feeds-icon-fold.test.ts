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

beforeAll(() => {
  const src = readFileSync(join(here, "../public/js/chat-agent-feeds-render.js"), "utf8");
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    src + "\nreturn { iconForType, isTerminalStatus, DEFAULT_AGENT_ICON, formatTokens, tokenBarFillPct };"
  );
  const m = factory();
  iconForType = m.iconForType;
  isTerminalStatus = m.isTerminalStatus;
  DEFAULT_AGENT_ICON = m.DEFAULT_AGENT_ICON;
  formatTokens = m.formatTokens;
  tokenBarFillPct = m.tokenBarFillPct;
});

describe("iconForType (C8 per-type icons)", () => {
  it("maps distinct op types to DISTINCT glyphs (the whole point)", () => {
    const icons = [
      iconForType("app_build"),
      iconForType("research"),
      iconForType("self_edit"),
      iconForType("refactor"),
      iconForType("freeform"),
      iconForType("scheduled_mission"),
    ];
    // All non-default and all different from one another.
    expect(icons.every((g) => g !== DEFAULT_AGENT_ICON)).toBe(true);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("build_app aliases app_build (model-prompt spelling) to the same glyph", () => {
    expect(iconForType("build_app")).toBe(iconForType("app_build"));
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
      iconForType("app_build"), iconForType("research"), iconForType("self_edit"),
      iconForType("refactor"), iconForType("freeform"), iconForType("scheduled_mission"),
      iconForType("agent"), iconForType("coder"),
    ];
    expect(workerGlyphs).not.toContain(sup);
  });

  it("aliases `supervisor` to the same glyph as `orchestrator`", () => {
    expect(iconForType("supervisor")).toBe(iconForType("orchestrator"));
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
