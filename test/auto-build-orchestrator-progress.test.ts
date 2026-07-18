import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scripted = vi.hoisted(() => ({
  events: [] as Array<{ type: string; chunkNumber: number; totalChunks: number; message: string }>,
  lastChunk: 2,
}));

vi.mock("../src/auto-build/loop.js", () => ({
  runBuildLoop: vi.fn(async (opts: { onEvent?: (event: Record<string, unknown>) => void }) => {
    const events = scripted.events.map(event => ({ ...event, elapsedMs: 0 }));
    for (const event of events) opts.onEvent?.(event);
    return {
      status: "halted",
      lastChunk: scripted.lastChunk,
      chunksCommitted: 1,
      haltReason: "merge blocked",
      outcomes: [],
      events,
    };
  }),
}));

const unregisterSpy = vi.fn();
vi.mock("../src/auto-build/orchestrator/registry.js", () => ({
  register: vi.fn(),
  unregister: (projectDir: string) => unregisterSpy(projectDir),
}));

vi.mock("../src/ops/session-bridge.js", () => ({
  broadcastToSession: vi.fn(),
}));

import { startOrchestration } from "../src/auto-build/orchestrator/manager.js";
import * as state from "../src/auto-build/orchestrator/state.js";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "auto-build-progress-"));
  unregisterSpy.mockClear();
  scripted.lastChunk = 2;
  scripted.events = [
    { type: "chunk-start", chunkNumber: 1, totalChunks: 3, message: "start 1" },
    { type: "commit", chunkNumber: 1, totalChunks: 3, message: "spec commit" },
    { type: "commit", chunkNumber: 1, totalChunks: 3, message: "code commit" },
    { type: "chunk-landed", chunkNumber: 1, totalChunks: 3, message: "landed" },
    { type: "chunk-landed", chunkNumber: 1, totalChunks: 3, message: "duplicate landed" },
    { type: "chunk-start", chunkNumber: 3, totalChunks: 3, message: "parallel start 3" },
    { type: "commit", chunkNumber: 3, totalChunks: 3, message: "worktree commit" },
    { type: "chunk-landed", chunkNumber: 3, totalChunks: 3, message: "merged out of order" },
    { type: "chunk-start", chunkNumber: 2, totalChunks: 3, message: "start 2" },
    { type: "commit", chunkNumber: 2, totalChunks: 3, message: "worktree pre-merge commit" },
    { type: "halt", chunkNumber: 2, totalChunks: 3, message: "merge blocked" },
  ];
});

afterEach(() => {
  try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("orchestrator durable chunk progress", () => {
  it("ignores Git commit events and advances once per landed chunk", async () => {
    startOrchestration({
      sessionId: "session-progress",
      projectDir,
      planPath: join(projectDir, "spec", "plan.md"),
      plan: { chunks: [{ number: 1 }, { number: 2 }, { number: 3 }] } as never,
      startingChunk: 1,
    });

    await vi.waitFor(() => expect(state.read(projectDir)?.phase).toBe("halted"));
    const persisted = state.read(projectDir)!;
    expect(persisted.chunksCommitted).toBe(1);
    expect(persisted.resumeAtChunk).toBe(2);
    expect(persisted.currentChunk).toBe(2);
    expect(persisted.phase).toBe("halted");
    expect(unregisterSpy).not.toHaveBeenCalled();
  });

  it("buffers out-of-order landed chunks and advances the durable prefix once", async () => {
    scripted.lastChunk = 3;
    scripted.events = [
      { type: "chunk-start", chunkNumber: 1, totalChunks: 3, message: "start 1" },
      { type: "chunk-landed", chunkNumber: 1, totalChunks: 3, message: "landed 1" },
      { type: "chunk-start", chunkNumber: 3, totalChunks: 3, message: "start 3" },
      { type: "chunk-landed", chunkNumber: 3, totalChunks: 3, message: "landed 3" },
      { type: "chunk-landed", chunkNumber: 3, totalChunks: 3, message: "duplicate 3" },
      { type: "chunk-start", chunkNumber: 2, totalChunks: 3, message: "start 2" },
      { type: "chunk-landed", chunkNumber: 2, totalChunks: 3, message: "landed 2" },
      { type: "halt", chunkNumber: 3, totalChunks: 3, message: "stop after landed prefix" },
    ];

    startOrchestration({
      sessionId: "session-prefix",
      projectDir,
      planPath: join(projectDir, "spec", "plan.md"),
      plan: { chunks: [{ number: 1 }, { number: 2 }, { number: 3 }] } as never,
      startingChunk: 1,
    });

    await vi.waitFor(() => expect(state.read(projectDir)?.phase).toBe("halted"));
    const persisted = state.read(projectDir)!;
    expect(persisted.chunksCommitted).toBe(3);
    expect(persisted.resumeAtChunk).toBe(4);
  });
});
