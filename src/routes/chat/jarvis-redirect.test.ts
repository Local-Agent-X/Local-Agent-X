/**
 * Worker-redirect ack delivery — the 2026-07-13 stranded-turn fix.
 *
 * When a mid-build user message is redirected to the running worker, the
 * ack + terminal `done` must go through the caller-provided emitter on
 * EVERY transport. The old code wrote them to sseSink only (null on WS),
 * so a WS client's optimistic turn — placeholder bubble, STREAMING state,
 * no opId — spun forever: no chat op ever started, the stuck-stream
 * watchdog only watches ops with an opId, and the orchestrator's failChat
 * net no-ops because no ActiveChat was registered.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ServerEvent } from "../../types.js";
import { tryWorkerRedirect } from "./jarvis-redirect.js";

const classifyWorkerRedirect = vi.fn();
const opRedirect = vi.fn();
const opRedirectOnce = vi.fn();

vi.mock("../../ops/session-bridge.js", () => ({
  listOpsForSession: vi.fn(() => ["op_app_build_test1"]),
  getOpTask: vi.fn(() => "build a fan page"),
}));
vi.mock("../../ops/op-store.js", () => ({
  readOp: vi.fn(() => ({ id: "op_app_build_test1", status: "running", type: "app_build" })),
  isInteractiveHostOpType: vi.fn(() => false),
}));
vi.mock("../../canonical-loop/index.js", () => ({
  opRedirect: (...args: unknown[]) => opRedirect(...args),
  opRedirectOnce: (...args: unknown[]) => opRedirectOnce(...args),
}));
vi.mock("../../routing/worker-redirect-classifier.js", () => ({
  classifyWorkerRedirect: (...args: unknown[]) => classifyWorkerRedirect(...args),
}));

function run(message: string, ingressKey?: string) {
  const emitted: ServerEvent[] = [];
  const emit = (ev: ServerEvent) => emitted.push(ev);
  const result = tryWorkerRedirect({
    sessionId: "sess-redirect",
    message,
    recentSessionMessages: [{ role: "user", content: "make me a fan page" }],
    emit,
    ingressKey,
  });
  return { result, emitted };
}

beforeEach(() => {
  classifyWorkerRedirect.mockReset();
  opRedirect.mockReset();
  opRedirect.mockReturnValue({ ok: true });
  opRedirectOnce.mockReset();
  opRedirectOnce.mockReturnValue({ ok: true });
});

describe("tryWorkerRedirect ack delivery", () => {
  it("emits the ack delta then a terminal done through the provided emitter on redirect", async () => {
    classifyWorkerRedirect.mockResolvedValue({ redirect: true, reason: "feedback for the build" });

    const { result, emitted } = run("can we use photos?");
    await expect(result).resolves.toBe(true);

    expect(emitted).toHaveLength(2);
    expect(emitted[0].type).toBe("stream");
    expect((emitted[0] as { delta: string }).delta).toContain("can we use photos?");
    // The done is what ends the client's optimistic turn — without it the
    // bubble spins forever on WS.
    expect(emitted[1].type).toBe("done");
  });

  it("emits nothing and returns false when the classifier says no redirect", async () => {
    classifyWorkerRedirect.mockResolvedValue({ redirect: false, reason: "new topic" });

    const { result, emitted } = run("what's the weather?");
    await expect(result).resolves.toBe(false);
    expect(emitted).toHaveLength(0);
  });

  it("emits nothing when the redirect dispatch itself fails", async () => {
    classifyWorkerRedirect.mockResolvedValue({ redirect: true, reason: "feedback" });
    opRedirect.mockReturnValue({ ok: false });

    const { result, emitted } = run("can we use photos?");
    await expect(result).resolves.toBe(false);
    expect(emitted).toHaveLength(0);
  });

  it("uses canonical ingress-key dedupe for messaging redirects", async () => {
    classifyWorkerRedirect.mockResolvedValue({ redirect: true, reason: "feedback" });
    await expect(run("make it blue", "receipt-1").result).resolves.toBe(true);
    expect(opRedirectOnce).toHaveBeenCalledWith("op_app_build_test1", "make it blue", "jarvis-redirect", "receipt-1");
    expect(opRedirect).not.toHaveBeenCalled();
  });
});
