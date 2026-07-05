/**
 * Regression suite for terminal app-URL adoption in
 * src/canonical-loop/checkpoint.ts (commitTurn).
 *
 * Live bug (2026-07): after a framework (Next/Vite/…) app build completed,
 * the AGENTS-sidebar "Open" link pointed at /apps/<name>/index.html and
 * 404'd — framework apps have no index.html; the /apps proxy forwards the
 * path verbatim to the framework dev server. Root cause: op.appUrl is
 * stamped at op creation (src/tools/build-app.ts) BEFORE the build knows
 * whether it's a framework app, and the observer
 * (session-bridge-observer.ts) prefers op.appUrl over the APP_READY marker.
 * The app-build adapter DOES learn the real URL at the terminal
 * (finalizeFrameworkBuild → providerPayload.url) but couldn't write the op
 * record (turn-loop boundary rule). commitTurn — the one terminal write
 * site — now adopts the adapter's terminal providerPayload.url onto
 * op.appUrl on a "done" terminal, so every consumer of the persisted op
 * agrees on the corrected URL.
 */
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { commitTurn } from "../src/canonical-loop/index.js";
import { readOp, writeOp, newOpId } from "../src/ops/op-store.js";
import type { Op } from "../src/ops/types.js";
import type { CommitTurnInput, ProviderStateEnvelope } from "../src/canonical-loop/types.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const tracked: string[] = [];
const track = <T extends string>(id: T): T => { tracked.push(id); return id; };

afterAll(() => {
  for (const id of tracked) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
});

const FLAT_URL = "http://127.0.0.1:7007/apps/next-demo/index.html";
const PROXY_URL = "http://127.0.0.1:7007/apps/next-demo/";

function providerState(payload: unknown): ProviderStateEnvelope {
  return { adapterName: "app_build", adapterVersion: "1.0.0", providerPayload: payload };
}

function mkOp(label: string, over: Partial<Op> = {}): Op {
  return {
    id: track(newOpId(`ckpt_appurl_${label}`)),
    type: "app_build",
    task: `checkpoint-app-url ${label}`,
    contextPack: {} as Op["contextPack"],
    lane: "build",
    retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] },
    ownerId: "test-checkpoint-app-url",
    visibility: "private",
    status: "running",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
    appUrl: FLAT_URL,
    canonical: { state: "running" },
    ...over,
  };
}

function commitInput(op: Op, over: Partial<CommitTurnInput> = {}): CommitTurnInput {
  return {
    op,
    turnIdx: 0,
    providerState: providerState(null),
    messages: [{ role: "assistant", content: { text: `APP_READY: ${PROXY_URL}` } }],
    toolCallSummary: [],
    terminalReason: null,
    ...over,
  };
}

describe("commitTurn — terminal adoption of the adapter's finalized app URL", () => {
  it("framework build completes → op.appUrl becomes the /apps/<name>/ proxy URL, not /index.html (the Open-link regression)", () => {
    const op = mkOp("framework");
    writeOp(op);

    commitTurn(commitInput(op, {
      terminalReason: "done",
      providerState: providerState({ url: PROXY_URL, stopReason: "app_ready", framework: "next" }),
    }));

    // The observer derives the sidebar "Open" link from the persisted
    // op.appUrl (session-bridge-observer.ts, `op.appUrl || extract...`),
    // reading it AFTER transitionOp persisted — so disk is the seam.
    const after = readOp(op.id);
    expect(after?.appUrl).toBe(PROXY_URL);
    expect(after?.appUrl).not.toContain("index.html");
    expect(after?.status).toBe("completed");
  });

  it("static build: terminal url equals the creation-time flat URL → unchanged", () => {
    const op = mkOp("static");
    writeOp(op);

    commitTurn(commitInput(op, {
      terminalReason: "done",
      providerState: providerState({ url: FLAT_URL, stopReason: "app_ready" }),
    }));

    expect(readOp(op.id)?.appUrl).toBe(FLAT_URL);
  });

  it("error terminal does not adopt a payload url — a failed build must not rewrite the record", () => {
    const op = mkOp("errterm");
    writeOp(op);

    commitTurn(commitInput(op, {
      terminalReason: "error",
      providerState: providerState({ url: PROXY_URL, stopReason: "dev_server_failed" }),
    }));

    const after = readOp(op.id);
    expect(after?.appUrl).toBe(FLAT_URL);
    expect(after?.status).toBe("failed");
  });

  it("non-terminal turn does not adopt a payload url", () => {
    const op = mkOp("midturn");
    writeOp(op);

    commitTurn(commitInput(op, {
      terminalReason: null,
      providerState: providerState({ url: PROXY_URL }),
    }));

    expect(readOp(op.id)?.appUrl).toBe(FLAT_URL);
  });

  it("op without a creation-time appUrl (non-app op) never gains one from a stray payload url", () => {
    const op = mkOp("no-anchor", { type: "freeform", appUrl: undefined, lane: "interactive" });
    writeOp(op);

    commitTurn(commitInput(op, {
      terminalReason: "done",
      providerState: providerState({ url: PROXY_URL }),
    }));

    expect(readOp(op.id)?.appUrl).toBeUndefined();
  });

  it("null providerPayload on a done terminal is inert (no throw, appUrl preserved)", () => {
    const op = mkOp("null-payload");
    writeOp(op);

    commitTurn(commitInput(op, {
      terminalReason: "done",
      providerState: providerState(null),
    }));

    expect(readOp(op.id)?.appUrl).toBe(FLAT_URL);
  });
});
