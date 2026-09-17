// A compacted turn publishes what the model was shown, so a tool check never
// mistakes the transcript for the model's view (muse, grade-school, 2026-09-17:
// the read-dedup stub said "you already hold this file" for a read the
// compaction had summarized away, seven times in one turn).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("./compact-history.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./compact-history.js")>();
  return { ...actual, compactHistory: vi.fn(actual.compactHistory) };
});

import type { Op } from "../../ops/types.js";
import { appendOpMessage } from "../store.js";
import { opDir } from "../../ops/event-log.js";
import { compactHistory } from "./compact-history.js";
import { buildTurnInput } from "./build-input.js";
import { getModelView } from "../../tool-execution/model-view.js";

const mockCompact = vi.mocked(compactHistory);
let dir: string;
let prevEnv: string | undefined;
let opId: string;
let seq = 0;

const op = (): Op => ({ id: opId, type: "chat_turn", model: "muse-glimmer:30b", task: "fix it", lane: "interactive" }) as unknown as Op;

beforeEach(() => {
  prevEnv = process.env.LAX_DATA_DIR;
  dir = mkdtempSync(join(tmpdir(), "lax-buildinput-view-"));
  process.env.LAX_DATA_DIR = dir;
  opId = `op_bi_view_${process.pid}_${seq++}`;
  appendOpMessage({ messageId: "u-0", opId, turnIdx: 0, seqInTurn: 0, role: "user", content: { text: "fix it" }, createdAt: "2026-09-17T07:00:00.000Z" });
  appendOpMessage({
    messageId: "a-0", opId, turnIdx: 0, seqInTurn: 1, role: "assistant",
    content: { text: "", toolCalls: [{ id: "call_r", name: "read", arguments: "{\"path\":\"/w/f.py\"}" }] },
    createdAt: "2026-09-17T07:00:01.000Z",
  });
  appendOpMessage({ messageId: "t-0", opId, turnIdx: 0, seqInTurn: 2, role: "tool_result", content: { toolCallId: "call_r", text: "class School: ..." }, createdAt: "2026-09-17T07:00:02.000Z" });
  mockCompact.mockReset();
});

afterEach(() => {
  try { rmSync(opDir(opId), { recursive: true, force: true }); } catch { /* ignore */ }
  if (prevEnv === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prevEnv;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("buildTurnInput publishes the model's view", () => {
  it("records the compacted view, without the rows the summary replaced", async () => {
    mockCompact.mockImplementation(async (messages) => ({
      messages: [{ messageId: "summary", role: "user", content: { text: "[summary] read f.py" } }, messages[0]],
      compacted: true,
    }) as Awaited<ReturnType<typeof compactHistory>>);
    await buildTurnInput(op(), 1, null);
    const view = getModelView(opId)!;
    expect(view).not.toBeNull();
    expect(JSON.stringify(view)).toContain("[summary] read f.py");
    expect(view.some((m) => m.role === "tool")).toBe(false);
  });

  it("clears the view when the turn was not compacted: the transcript is the view", async () => {
    mockCompact.mockImplementationOnce(async (messages) => ({ messages: messages.slice(1), compacted: true }) as Awaited<ReturnType<typeof compactHistory>>);
    await buildTurnInput(op(), 1, null);
    expect(getModelView(opId)).not.toBeNull();
    mockCompact.mockImplementationOnce(async (messages) => ({ messages, compacted: false }) as Awaited<ReturnType<typeof compactHistory>>);
    await buildTurnInput(op(), 2, null);
    expect(getModelView(opId)).toBeNull();
  });
});
