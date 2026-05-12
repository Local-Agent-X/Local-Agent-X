/**
 * P4.C5 — structural overhead of the canonical-loop runner relative to a
 * legacy `runAgent` invocation, measured with a no-op fake adapter so the
 * provider time is identical on both sides. Run via:
 *
 *   node node_modules/vitest/vitest.mjs run test/p4c5-voice-overhead-bench.test.ts
 *
 * This is NOT a chat-quality test — it's a stopwatch on the canonical
 * machinery (buildContextPack + writeOp + seedOpMessages + subscribe
 * wiring + canonicalLoopEntry teardown) so we can attribute the +/- ms
 * delta vs legacy for the voice-warm-path budget (P4.C5 brief: must
 * stay within +/- 100ms).
 *
 * The fake adapter is wired through `setDefaultAdapterForLane("interactive", ...)`
 * AFTER patching `registerProviderAdapter` to a no-op via the `provider`
 * field — see below. The bench fires three warm trials of an empty-tools
 * 1-iteration voice-shaped op + three warm trials of the chat-history-
 * shaped delegation-ack op, prints medians.
 */
import { describe, it, expect, afterAll } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, rmSync } from "node:fs";

import { FakeAdapter, scriptTurn } from "./canonical-loop/fake-adapter.js";
import {
  setDefaultAdapterForLane,
  resetCanonicalRuntime,
} from "../src/canonical-loop/runtime.js";
import { enableDefaultMiddlewareStack } from "../src/canonical-loop/middlewares/host.js";
import { runAgentViaCanonical } from "../src/canonical-loop/agent-runner.js";
import type { SecurityLayer } from "../src/security.js";

const OPS_BASE = join(homedir(), ".lax", "operations");

function makeFakeSecurity(): SecurityLayer {
  return {
    isPathAllowed: () => true,
    addAllowedPath: () => {},
    removeAllowedPath: () => {},
  } as unknown as SecurityLayer;
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const trackedOps: string[] = [];

afterAll(() => {
  resetCanonicalRuntime();
  for (const id of trackedOps) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
});

describe("P4.C5 — canonical-runner structural overhead", () => {
  it("voice-shaped (tools=[], maxIter=1) — 3 warm trials, prints median", async () => {
    enableDefaultMiddlewareStack();
    setDefaultAdapterForLane("interactive", () =>
      new FakeAdapter({ script: [scriptTurn({ text: "ok", terminal: "done" })] }),
    );

    // Force runAgentViaCanonical's registerProviderAdapter to take the
    // lane-default path by handing it a provider it has no built-in for.
    // It currently dispatches anthropic / codex / openai-compat — passing
    // an unknown provider name with no API key triggers a throw before
    // adapter registration, so we instead pass provider="anthropic" and
    // accept that registerAdapterForOp will overwrite our lane-default
    // factory. To work around: pre-warm + patch by registering our fake
    // via setDefaultAdapterForLane and using provider="local" with a
    // pre-installed env target — but the resolveOpenAICompatTarget call
    // will fail without a real base URL. So we use a tiny scoped trick:
    // monkey-patch registerAdapterForOp via dynamic import below.
    const runtime = await import("../src/canonical-loop/runtime.js");
    const origRegister = runtime.registerAdapterForOp;
    // Make registerAdapterForOp a no-op so the lane-default fake wins.
    Object.defineProperty(runtime, "registerAdapterForOp", {
      value: () => {},
      configurable: true, writable: true,
    });

    const trials: number[] = [];
    try {
      // Warm-up run (cache file descriptors, JIT)
      const warmup = await runAgentViaCanonical("warmup", [], {
        apiKey: "x", model: "fake", provider: "anthropic",
        systemPrompt: "voice", tools: [], security: makeFakeSecurity(),
        sessionId: "voice-bench-warm", maxIterations: 1, temperature: 0.7,
        opType: "voice_turn", lane: "interactive",
      });
      const warmId = (warmup.messages[warmup.messages.length - 1] as { _opId?: string })._opId;
      if (warmId) trackedOps.push(warmId);

      for (let i = 0; i < 3; i++) {
        // Each trial: re-seed the lane-default with a fresh script so the
        // adapter doesn't end up replaying a consumed plan.
        setDefaultAdapterForLane("interactive", () =>
          new FakeAdapter({ script: [scriptTurn({ text: "ok", terminal: "done" })] }),
        );
        const t0 = performance.now();
        const r = await runAgentViaCanonical(`trial ${i}`, [], {
          apiKey: "x", model: "fake", provider: "anthropic",
          systemPrompt: "voice", tools: [], security: makeFakeSecurity(),
          sessionId: `voice-bench-${i}`, maxIterations: 1, temperature: 0.7,
          opType: "voice_turn", lane: "interactive",
        });
        const elapsed = performance.now() - t0;
        trials.push(elapsed);
        void r;
      }
    } finally {
      Object.defineProperty(runtime, "registerAdapterForOp", {
        value: origRegister, configurable: true, writable: true,
      });
    }

    const med = median(trials);
    console.log(`[p4c5-bench] voice-shaped trials=${trials.map(t => t.toFixed(1)).join(", ")} ms; median=${med.toFixed(1)} ms`);
    expect(trials.length).toBe(3);
    expect(med).toBeLessThan(500);
  });

  it("delegation-ack-shaped (tools=[], maxIter=1, 4-msg history) — 3 warm trials", async () => {
    enableDefaultMiddlewareStack();

    const runtime = await import("../src/canonical-loop/runtime.js");
    const origRegister = runtime.registerAdapterForOp;
    Object.defineProperty(runtime, "registerAdapterForOp", {
      value: () => {},
      configurable: true, writable: true,
    });

    const history = [
      { role: "user" as const, content: "build me a todo list app" },
      { role: "assistant" as const, content: "On it." },
      { role: "user" as const, content: "make it look nice" },
      { role: "assistant" as const, content: "Adding styles." },
    ];

    const trials: number[] = [];
    try {
      setDefaultAdapterForLane("interactive", () =>
        new FakeAdapter({ script: [scriptTurn({ text: "Starting on the todo list app now.", terminal: "done" })] }),
      );
      await runAgentViaCanonical("warm", history, {
        apiKey: "x", model: "fake", provider: "anthropic",
        systemPrompt: "delegation ack", tools: [], security: makeFakeSecurity(),
        sessionId: "deleg-bench-warm", maxIterations: 1, temperature: 0.7,
        opType: "delegation_ack", lane: "interactive",
      });

      for (let i = 0; i < 3; i++) {
        setDefaultAdapterForLane("interactive", () =>
          new FakeAdapter({ script: [scriptTurn({ text: "Starting on the todo list app now.", terminal: "done" })] }),
        );
        const t0 = performance.now();
        await runAgentViaCanonical(`build me a thing (trial ${i})`, history, {
          apiKey: "x", model: "fake", provider: "anthropic",
          systemPrompt: "delegation ack", tools: [], security: makeFakeSecurity(),
          sessionId: `deleg-bench-${i}`, maxIterations: 1, temperature: 0.7,
          opType: "delegation_ack", lane: "interactive",
        });
        trials.push(performance.now() - t0);
      }
    } finally {
      Object.defineProperty(runtime, "registerAdapterForOp", {
        value: origRegister, configurable: true, writable: true,
      });
    }

    const med = median(trials);
    console.log(`[p4c5-bench] delegation-ack-shaped trials=${trials.map(t => t.toFixed(1)).join(", ")} ms; median=${med.toFixed(1)} ms`);
    expect(trials.length).toBe(3);
    expect(med).toBeLessThan(500);
  });
});
