/**
 * workers_list is how a client that connected mid-job (the phone, after any new
 * link) learns which workers are live: the router answers that socket with a
 * workers_snapshot built from the real op store.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import type { Op } from "../ops/types.js";

// op-store binds its base dir from getLaxDir() at import.
const prevLaxDir = process.env.LAX_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "lax-workers-list-"));
process.env.LAX_DATA_DIR = dataDir;
afterAll(() => {
  if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevLaxDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const { attachMessageRouter } = await import("./message-router.js");
const { writeOp } = await import("../ops/op-store.js");
const { parseWorkersSnapshot } = await import("../broker-transport/vendor/protocol.js");

async function ask(frame: Record<string, unknown>): Promise<unknown[]> {
  const sent: string[] = [];
  let onMessage: ((data: Buffer) => unknown) | null = null;
  const ws = {
    readyState: 1,
    send: (out: string) => { sent.push(out); },
    on: (evt: string, cb: (data: Buffer) => unknown) => { if (evt === "message") onMessage = cb; },
  } as unknown as WebSocket;
  attachMessageRouter({ ws, subscriptions: new Set<string>() });
  await onMessage!(Buffer.from(JSON.stringify(frame)));
  return sent.map((out) => JSON.parse(out) as unknown);
}

describe("workers_list", () => {
  it("answers with the live workers, in the shape the phone parses", async () => {
    writeOp({
      id: "op_live", type: "app_build", task: "Build a habit tracker",
      contextPack: {} as Op["contextPack"], lane: "build" as Op["lane"],
      retryPolicy: { maxRecoveryAttempts: 3, backoffMs: [5_000] }, ownerId: "u",
      visibility: "private" as Op["visibility"], status: "running" as Op["status"],
      createdAt: new Date().toISOString(), attemptCount: 0,
      canonical: { state: "running", flagValue: true, sessionId: "chat-1" },
    });

    const frames = await ask({ type: "workers_list" });
    const snapshot = frames.map(parseWorkersSnapshot).find((f) => f !== null);
    expect(snapshot?.workers).toContainEqual(expect.objectContaining({
      opId: "op_live", sessionId: "chat-1", task: "Build a habit tracker", status: "running",
    }));
  });
});
