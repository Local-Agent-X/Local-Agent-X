/**
 * An over-window request is compacted and retried — it never ends the op.
 *
 * Live 2026-09-16 (op-outcomes, muse-glimmer:30b, correction-chain): the op was
 * sixty tool calls into a coding task when the request outgrew the 65,536-token
 * window. Two independent defects turned that into a failed task:
 *
 *   1. The adapter's own preflight refused the send with code
 *      `context_window_exceeded`, but overflow recovery was routed only by
 *      matching PROVIDER error prose — and the preflight's wording matched none
 *      of it. The op ended as an error instead of compacting.
 *   2. Even a forced compaction returned the view unchanged whenever the
 *      summarizer produced nothing, so the retry was refused again, identically.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../event-emitter.js", () => ({ emit: vi.fn(), publishStreamChunk: vi.fn() }));
vi.mock("../state-machine.js", () => ({ transitionOp: vi.fn() }));
vi.mock("./nudges.js", () => ({ appendNudgeAsUserMessage: vi.fn() }));
vi.mock("../../context-manager/status.js", () => ({ getContextStatus: vi.fn() }));
vi.mock("../../context-manager/compaction.js", () => ({ summarizeOldMessages: vi.fn() }));
const loggerMock = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../../logger.js", () => ({ createLogger: () => loggerMock }));

import { recoverReportedAdapterError } from "./reported-adapter-recovery.js";
import { clearOverflowAttempts } from "./adapter-throw-recovery.js";
import { compactHistory } from "./compact-history.js";
import { clearSummaryCache } from "./compact-summary-cache.js";
import { CONTEXT_WINDOW_EXCEEDED_CODE } from "../adapter-contract.js";
import { classify } from "../../errors/classifier.js";
import { getContextStatus } from "../../context-manager/status.js";
import { summarizeOldMessages } from "../../context-manager/compaction.js";
import type { Op } from "../../ops/types.js";
import type { CanonicalMessage } from "../contract-types.js";

const mockStatus = vi.mocked(getContextStatus);
const mockSummarize = vi.mocked(summarizeOldMessages);

// Verbatim from the failing run's recorded error.
const PREFLIGHT_MESSAGE =
  "Request needs ~65,721 tokens but muse-glimmer:30b is running with a 65,536-token context window " +
  "(1,024 reserved for the response). Breakdown: system prompt ~22,030, tools ~20,516, messages ~23,175.";

const op = (id: string) => ({ id } as unknown as Op);
const idle = { streamed: false, finalized: 0, toolCalls: 0, observedTools: 0 };

describe("the adapter's own over-window refusal is recovered, not terminal", () => {
  beforeEach(() => clearOverflowAttempts("op-preflight"));

  it("is not recognizable by its wording — which is why the code has to carry it", () => {
    expect(classify(PREFLIGHT_MESSAGE).recovery).not.toBe("compress");
  });

  it("routes the preflight code to compact-and-retry", () => {
    const result = recoverReportedAdapterError(op("op-preflight"),
      { code: CONTEXT_WINDOW_EXCEEDED_CODE, message: PREFLIGHT_MESSAGE, retryable: false }, 3, idle);
    expect(result, "a measured overflow must not end the op").toBeDefined();
    expect(result!.terminalReason).toBeNull();
  });

  it("still recognizes a provider's own over-window wording", () => {
    const result = recoverReportedAdapterError(op("op-provider"),
      { code: "http_400", message: "This model's maximum context length is 65536 tokens", retryable: false }, 3, idle);
    expect(result?.terminalReason).toBeNull();
    clearOverflowAttempts("op-provider");
  });

  it("stays bounded — a view that cannot be shrunk still ends eventually", () => {
    const err = { code: CONTEXT_WINDOW_EXCEEDED_CODE, message: PREFLIGHT_MESSAGE, retryable: false };
    expect(recoverReportedAdapterError(op("op-bounded"), err, 1, idle)).toBeDefined();
    expect(recoverReportedAdapterError(op("op-bounded"), err, 2, idle)).toBeDefined();
    expect(recoverReportedAdapterError(op("op-bounded"), err, 3, idle), "past the retry cap").toBeUndefined();
  });
});

describe("a compaction that must fit still fits when the summarizer is down", () => {
  const u = (id: string, text: string): CanonicalMessage => ({ messageId: id, role: "user", content: { text } });
  const a = (id: string, text: string): CanonicalMessage => ({ messageId: id, role: "assistant", content: { text } });
  const TASK = "In pricing-app, add a formatPrice(cents) function to src/format.js.";
  const history = () => [
    u("u1", TASK), a("a1", "reading the file"), u("u2", "[tool result] 40 lines"), a("a2", "editing"),
    u("u3", "[tool result] ok"), a("a3", "running tests"), u("u4", "[tool result] 1 failing"), a("a4", "fixing"),
  ];
  const status = (percentage: number, forceCompact: boolean) =>
    ({ usedTokens: 1, maxTokens: 1, percentage, level: forceCompact ? "critical" as const : "compact" as const, shouldCompact: true, forceCompact });

  beforeEach(() => {
    clearSummaryCache();
    mockStatus.mockReset();
    mockSummarize.mockReset().mockResolvedValue(null);
  });

  it("elides the head, says so, and keeps the original request verbatim", async () => {
    mockStatus.mockReturnValue(status(101, true));
    const msgs = history();
    const out = await compactHistory(msgs, "muse-glimmer:30b", null, "op-must-fit");

    expect(out.compacted, "an over-window view must come back smaller").toBe(true);
    expect(out.messages.length).toBeLessThan(msgs.length);
    const head = JSON.stringify(out.messages[0].content);
    expect(head).toContain("OMITTED to fit the context window");
    expect(head, "the model must still know what it was asked").toContain(TASK);
    expect(head).not.toContain("auto-summarized");
  });

  it("below the critical band, a missing summary still leaves the history alone", async () => {
    mockStatus.mockReturnValue(status(96, false));
    const msgs = history();
    const out = await compactHistory(msgs, "muse-glimmer:30b", null, "op-can-wait");
    expect(out.compacted).toBe(false);
    expect(out.messages).toBe(msgs);
  });

  it("a working summarizer is still preferred over an elision", async () => {
    mockStatus.mockReturnValue(status(101, true));
    mockSummarize.mockResolvedValue("User asked for formatPrice; tests are being fixed.");
    const out = await compactHistory(history(), "muse-glimmer:30b", null, "op-summary");
    const head = JSON.stringify(out.messages[0].content);
    expect(head).toContain("auto-summarized");
    expect(head).not.toContain("OMITTED");
  });
});
