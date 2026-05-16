import { afterAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { appendEvent, opDir, readEvents } from "../src/ops/event-log.js";
import type { OpEvent } from "../src/ops/types.js";

let counter = 0;
const opId = (tag: string): string => `op-evlog-test-${tag}-${Date.now()}-${counter++}`;

const createdOpIds: string[] = [];
const trackedOpId = (tag: string): string => {
  const id = opId(tag);
  createdOpIds.push(id);
  return id;
};

afterAll(() => {
  const base = join(homedir(), ".lax", "operations");
  for (const id of createdOpIds) {
    const dir = join(base, id);
    if (existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }
});

const mkEvent = (id: string, overrides: Partial<OpEvent> = {}): OpEvent => ({
  opId: id,
  type: "phase",
  ts: new Date().toISOString(),
  payload: { phase: "planning" },
  ...overrides,
});

describe("opDir", () => {
  it("creates the op directory under ~/.lax/operations and returns its path", () => {
    const id = trackedOpId("dir-create");
    const dir = opDir(id);
    expect(existsSync(dir)).toBe(true);
    expect(dir).toContain(id);
    expect(dir).toContain(".lax");
  });

  it("is idempotent — calling twice returns the same path and does not error", () => {
    const id = trackedOpId("dir-idem");
    const a = opDir(id);
    const b = opDir(id);
    expect(a).toBe(b);
    expect(existsSync(a)).toBe(true);
  });
});

describe("appendEvent + readEvents — round-trip", () => {
  it("appends one event and reads it back", () => {
    const id = trackedOpId("round-trip-1");
    const evt = mkEvent(id, { type: "started", payload: { initial: true } });
    appendEvent(evt);
    const events = readEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0].opId).toBe(id);
    expect(events[0].type).toBe("started");
    expect(events[0].payload).toEqual({ initial: true });
  });

  it("appends in order and preserves order on read (synchronous flush)", () => {
    const id = trackedOpId("order");
    appendEvent(mkEvent(id, { type: "started" }));
    appendEvent(mkEvent(id, { type: "phase", payload: { phase: "a" } }));
    appendEvent(mkEvent(id, { type: "phase", payload: { phase: "b" } }));
    appendEvent(mkEvent(id, { type: "completed" }));
    const events = readEvents(id);
    expect(events.map(e => e.type)).toEqual(["started", "phase", "phase", "completed"]);
    expect(events[1].payload.phase).toBe("a");
    expect(events[2].payload.phase).toBe("b");
  });

  it("returns empty array for an op with no events on disk", () => {
    const id = trackedOpId("empty");
    expect(readEvents(id)).toEqual([]);
  });

  it("returns empty array even before opDir is called (no race)", () => {
    const id = `op-evlog-never-${Date.now()}-${counter++}`;
    expect(readEvents(id)).toEqual([]);
  });
});

describe("appendEvent — redaction wired in", () => {
  it("redacts sensitive field names before disk-write", () => {
    const id = trackedOpId("redact-field");
    appendEvent(mkEvent(id, {
      type: "tool_result",
      payload: { user: "alice", password: "hunter2-secret-123" },
    }));
    const events = readEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0].redacted).toBe(true);
    expect((events[0].payload as { password: string }).password).toBe("<redacted>");
    expect((events[0].payload as { user: string }).user).toBe("alice");
  });

  it("redacts sensitive: true events to the stub form on disk", () => {
    const id = trackedOpId("redact-flag");
    appendEvent(mkEvent(id, {
      type: "tool_result",
      sensitive: true,
      payload: { secret: "abc", visible: "also gone" },
    }));
    const events = readEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0].redacted).toBe(true);
    expect(events[0].payload).toMatchObject({ redacted: true });
    expect(events[0].payload.secret).toBeUndefined();
  });

  it("does not flag clean events as redacted", () => {
    const id = trackedOpId("clean");
    appendEvent(mkEvent(id, { type: "phase", payload: { count: 1 } }));
    const events = readEvents(id);
    expect(events[0].redacted).toBeUndefined();
  });
});

describe("appendEvent — JSONL line framing", () => {
  it("each event ends with a single \\n on disk", () => {
    const id = trackedOpId("framing");
    appendEvent(mkEvent(id, { type: "started" }));
    appendEvent(mkEvent(id, { type: "completed" }));
    const path = join(opDir(id), "events.jsonl");
    const raw = readFileSync(path, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    const lines = raw.split("\n").filter(l => l.length > 0);
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });

  it("event payload is serialized as JSON (not pretty-printed)", () => {
    const id = trackedOpId("compact");
    appendEvent(mkEvent(id, { payload: { nested: { a: 1 } } }));
    const path = join(opDir(id), "events.jsonl");
    const raw = readFileSync(path, "utf-8");
    expect(raw).not.toContain("\n  ");
  });
});

describe("readEvents — robustness", () => {
  it("skips malformed JSON lines and returns the parseable ones", () => {
    const id = trackedOpId("malformed");
    appendEvent(mkEvent(id, { type: "started" }));
    const path = join(opDir(id), "events.jsonl");
    const fs = require("node:fs");
    fs.appendFileSync(path, "not-valid-json\n", "utf-8");
    appendEvent(mkEvent(id, { type: "completed" }));
    const events = readEvents(id);
    expect(events.map(e => e.type)).toEqual(["started", "completed"]);
  });

  it("ignores blank lines", () => {
    const id = trackedOpId("blank");
    appendEvent(mkEvent(id, { type: "started" }));
    const path = join(opDir(id), "events.jsonl");
    const fs = require("node:fs");
    fs.appendFileSync(path, "\n\n\n", "utf-8");
    appendEvent(mkEvent(id, { type: "completed" }));
    expect(readEvents(id).map(e => e.type)).toEqual(["started", "completed"]);
  });
});
