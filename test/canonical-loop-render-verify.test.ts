/**
 * Tier 1.A — render-verify gate.
 *
 * After a turn that wrote/edited files under workspace/apps/<id>/, the
 * canonical loop waits briefly for runtime errors from the preview iframe.
 * If errors land, the terminal "done" is suppressed, the errors get
 * appended as a synthetic user nudge for the next turn, and a per-op
 * retry counter increments. A non-app-modifying turn skips the gate
 * entirely. The retry cap stops an unfixable bug from spinning forever.
 *
 * Tests target the pure helpers in turn-loop/render-verify.ts directly
 * — no full driveTurn boot needed for the four cases the PRD calls out.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  pushPreviewRuntimeError,
  runRenderVerifyGate,
  turnTouchedAppFiles,
  formatRuntimeErrorsForAgent,
  getRenderVerifyRetries,
  clearRenderVerifyStateForOp,
  _resetRenderVerifyState,
  type PreviewRuntimeError,
} from "../src/canonical-loop/turn-loop/render-verify.js";
import type { ToolCall } from "../src/canonical-loop/contract-types.js";

const OP_ID = "op_render_verify_test";

beforeEach(() => {
  _resetRenderVerifyState();
});

afterEach(() => {
  clearRenderVerifyStateForOp(OP_ID);
  _resetRenderVerifyState();
});

const mkErr = (message: string, source = "index.html", line = 1): PreviewRuntimeError => ({
  kind: "error",
  message,
  source,
  line,
  col: 0,
  ts: Date.now(),
});

// Tiny sleep stub — resolves immediately so the gate's poll loop completes
// in a microtask. Real-time waits would make the suite flaky and slow.
const fastSleep = (_ms: number) => Promise.resolve();

describe("render-verify gate — buffered errors flip terminal to retry", () => {
  it("errors in buffer → shouldRetry true, retry counter increments to 1", async () => {
    pushPreviewRuntimeError(OP_ID, mkErr("TypeError: foo"));
    const result = await runRenderVerifyGate(OP_ID, { totalMs: 50, pollMs: 5, sleep: fastSleep });
    expect(result.shouldRetry).toBe(true);
    expect(result.capReached).toBe(false);
    expect(result.retryCount).toBe(1);
    expect(result.nudge).toContain("TypeError: foo");
    expect(result.nudge).toContain("Preview iframe loaded but reported issues");
    expect(getRenderVerifyRetries(OP_ID)).toBe(1);
  });

  it("retry counter survives across calls until the cap", async () => {
    pushPreviewRuntimeError(OP_ID, mkErr("first"));
    const r1 = await runRenderVerifyGate(OP_ID, { totalMs: 50, pollMs: 5, sleep: fastSleep });
    expect(r1.retryCount).toBe(1);

    pushPreviewRuntimeError(OP_ID, mkErr("second"));
    const r2 = await runRenderVerifyGate(OP_ID, { totalMs: 50, pollMs: 5, sleep: fastSleep });
    expect(r2.retryCount).toBe(2);
    expect(r2.shouldRetry).toBe(true);
    expect(r2.capReached).toBe(false);
  });
});

describe("render-verify gate — empty buffer is a clean no-op", () => {
  it("no errors → shouldRetry false, retry counter does NOT advance", async () => {
    // totalMs intentionally tiny so the test isn't slow if the fast-sleep
    // stub is bypassed.
    const result = await runRenderVerifyGate(OP_ID, { totalMs: 20, pollMs: 5, sleep: fastSleep });
    expect(result.shouldRetry).toBe(false);
    expect(result.capReached).toBe(false);
    expect(result.retryCount).toBe(0);
    expect(result.nudge).toBe("");
    expect(getRenderVerifyRetries(OP_ID)).toBe(0);
  });
});

describe("render-verify gate — retry cap stops infinite loops", () => {
  it("third invocation after two retries → shouldRetry false, capReached true, terminal stays done", async () => {
    pushPreviewRuntimeError(OP_ID, mkErr("err 1"));
    await runRenderVerifyGate(OP_ID, { totalMs: 50, pollMs: 5, sleep: fastSleep });
    pushPreviewRuntimeError(OP_ID, mkErr("err 2"));
    await runRenderVerifyGate(OP_ID, { totalMs: 50, pollMs: 5, sleep: fastSleep });

    expect(getRenderVerifyRetries(OP_ID)).toBe(2);

    pushPreviewRuntimeError(OP_ID, mkErr("err 3 — should be reported but not retried"));
    const result = await runRenderVerifyGate(OP_ID, { totalMs: 50, pollMs: 5, sleep: fastSleep });
    expect(result.shouldRetry).toBe(false);
    expect(result.capReached).toBe(true);
    expect(result.retryCount).toBe(2);
    expect(result.nudge).toContain("err 3");
    // Counter did NOT advance past the cap.
    expect(getRenderVerifyRetries(OP_ID)).toBe(2);
  });
});

describe("turnTouchedAppFiles — gates the gate", () => {
  it("a write under workspace/apps/<id>/ counts", () => {
    const calls: ToolCall[] = [
      { toolCallId: "1", tool: "write", args: { path: "workspace/apps/foo/index.html", content: "" } },
    ];
    expect(turnTouchedAppFiles(calls)).toBe(true);
  });

  it("a Windows-style backslash path also counts", () => {
    const calls: ToolCall[] = [
      { toolCallId: "1", tool: "write", args: { path: "workspace\\apps\\foo\\index.html", content: "" } },
    ];
    expect(turnTouchedAppFiles(calls)).toBe(true);
  });

  it("an edit on workspace/apps/<id>/styles.css counts", () => {
    const calls: ToolCall[] = [
      { toolCallId: "1", tool: "edit", args: { path: "/abs/workspace/apps/foo/styles.css" } },
    ];
    expect(turnTouchedAppFiles(calls)).toBe(true);
  });

  it("a build_app call counts even without an explicit path", () => {
    const calls: ToolCall[] = [
      { toolCallId: "1", tool: "build_app", args: { name: "foo" } },
    ];
    expect(turnTouchedAppFiles(calls)).toBe(true);
  });

  it("a read on an app file does NOT count (read isn't mutating)", () => {
    const calls: ToolCall[] = [
      { toolCallId: "1", tool: "read", args: { path: "workspace/apps/foo/index.html" } },
    ];
    expect(turnTouchedAppFiles(calls)).toBe(false);
  });

  it("a write outside workspace/apps/ does NOT count", () => {
    const calls: ToolCall[] = [
      { toolCallId: "1", tool: "write", args: { path: "src/foo.ts" } },
    ];
    expect(turnTouchedAppFiles(calls)).toBe(false);
  });

  it("empty tool-call list returns false (most chat turns)", () => {
    expect(turnTouchedAppFiles([])).toBe(false);
  });
});

describe("formatRuntimeErrorsForAgent — renders the nudge body", () => {
  it("formats one error with source + line", () => {
    const text = formatRuntimeErrorsForAgent([mkErr("TypeError: x", "app.js", 42)]);
    expect(text).toContain("[Error] TypeError: x at app.js:42");
    expect(text).toContain("Preview iframe loaded but reported issues");
    expect(text).toContain("Fix and re-run.");
  });

  it("formats console.error and unhandledrejection distinctly", () => {
    const errors: PreviewRuntimeError[] = [
      { kind: "console", message: "logged err", source: "", line: 0, col: 0, ts: 0 },
      { kind: "rejection", message: "promise rej", source: "", line: 0, col: 0, ts: 0 },
    ];
    const text = formatRuntimeErrorsForAgent(errors);
    expect(text).toContain("[console.error]");
    expect(text).toContain("[Rejection]");
  });

  it("formats CSP violations with the [CSP] tag and no trailing source", () => {
    const errors: PreviewRuntimeError[] = [
      { kind: "csp", message: "Refused: https://cdn.tailwindcss.com (style-src)", source: "", line: 0, col: 0, ts: 0 },
    ];
    const text = formatRuntimeErrorsForAgent(errors);
    expect(text).toContain("[CSP] Refused: https://cdn.tailwindcss.com (style-src)");
    // No " at " appended for CSP — message already self-contained
    expect(text).not.toContain("[CSP] Refused: https://cdn.tailwindcss.com (style-src) at");
  });

  it("formats resource 404s with the [404] tag", () => {
    const errors: PreviewRuntimeError[] = [
      { kind: "resource", message: "Failed to load resource: /img/hero.jpg", source: "/img/hero.jpg", line: 0, col: 0, ts: 0 },
    ];
    const text = formatRuntimeErrorsForAgent(errors);
    expect(text).toContain("[404] Failed to load resource: /img/hero.jpg");
  });

  it("formats blank-page heuristic with the [Empty] tag", () => {
    const errors: PreviewRuntimeError[] = [
      { kind: "blank", message: "Preview rendered no visible content (body text < 50 chars, no media elements)", source: "", line: 0, col: 0, ts: 0 },
    ];
    const text = formatRuntimeErrorsForAgent(errors);
    expect(text).toContain("[Empty] Preview rendered no visible content");
  });

  it("includes the CSP env spec and the 'Fix and re-run.' footer", () => {
    const text = formatRuntimeErrorsForAgent([mkErr("TypeError: x")]);
    expect(text).toContain("script-src 'self' 'unsafe-inline'");
    expect(text).toContain("img-src 'self' data: https: blob:");
    expect(text).toContain("External CDNs and Google Fonts are blocked");
    expect(text).toContain("Files resolve relative to index.html");
    expect(text).toContain("Fix and re-run.");
    // No babying — no retry counter, no "try harder"
    expect(text).not.toMatch(/retries? left/i);
    expect(text).not.toMatch(/try harder/i);
    expect(text).not.toMatch(/before saying done/i);
  });

  it("empty list → empty string", () => {
    expect(formatRuntimeErrorsForAgent([])).toBe("");
  });
});
