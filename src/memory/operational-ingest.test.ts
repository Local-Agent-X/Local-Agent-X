import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendActionLedger } from "../ops/action-ledger.js";
import { ingestOperationalOutcomes, composeFailureFact } from "./operational-ingest.js";
import type { MemoryIndex } from "./index.js";

let dir: string;
let prevEnv: string | undefined;

interface RememberCall { content: string; kind?: string }
interface RelationCall { subject: string; predicate: string; object: string; factId?: number }

function stubMemory() {
  const remembered: RememberCall[] = [];
  const relations: RelationCall[] = [];
  let nextId = 1;
  const memory = {
    rememberFact(content: string, opts?: { kind?: string }) {
      remembered.push({ content, kind: opts?.kind });
      return { ok: true, fact: { id: nextId++ } };
    },
    storeRelation(opts: RelationCall) {
      relations.push(opts);
    },
  } as unknown as MemoryIndex;
  return { memory, remembered, relations };
}

beforeEach(() => {
  prevEnv = process.env.LAX_DATA_DIR;
  dir = mkdtempSync(join(tmpdir(), "lax-ingest-"));
  process.env.LAX_DATA_DIR = dir;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = prevEnv;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function failedTurn(opId: string, ts: string, tools: Array<[string, "ok" | "error"]>) {
  appendActionLedger({
    ts,
    sessionId: "s1",
    opId,
    opType: "chat_turn",
    turnIdx: 0,
    task: "deploy the site",
    actions: tools.map(([tool, status]) => ({ tool, status })),
    terminalReason: status(tools),
  });
}
function status(tools: Array<[string, "ok" | "error"]>): "done" | "error" {
  return tools.some(([, s]) => s === "error") ? "error" : "done";
}

describe("operational ingest", () => {
  it("composeFailureFact is a single compact line", () => {
    const f = composeFailureFact("deploy the site", ["bash", "http_request"], "2026-06-06");
    expect(f).toBe('Tool(s) bash, http_request failed while working on "deploy the site" (2026-06-06).');
    expect(f.includes("\n")).toBe(false);
    expect(f.length).toBeLessThan(400);
  });

  it("writes one fact per failed op, with a relation per failed tool", () => {
    failedTurn("op1", "2026-06-06T10:00:00.000Z", [["bash", "error"], ["edit", "ok"]]);
    failedTurn("op1", "2026-06-06T10:01:00.000Z", [["http_request", "error"]]);
    const { memory, remembered, relations } = stubMemory();

    const res = ingestOperationalOutcomes(memory);

    expect(res.ingested).toBe(1); // one fact for op1
    expect(remembered[0].kind).toBe("experience");
    expect(remembered[0].content).toContain("bash");
    expect(remembered[0].content).toContain("http_request");
    // edit succeeded → not in the fact
    expect(remembered[0].content).not.toContain("edit");
    // a relation per failed tool, linked to the fact
    expect(relations.map(r => r.subject).sort()).toEqual(["bash", "http_request"]);
    expect(relations.every(r => r.predicate === "failed-during" && r.factId === 1)).toBe(true);
  });

  it("ignores ops with no failures", () => {
    failedTurn("op-ok", "2026-06-06T10:00:00.000Z", [["edit", "ok"], ["bash", "ok"]]);
    const { memory, remembered } = stubMemory();
    expect(ingestOperationalOutcomes(memory).ingested).toBe(0);
    expect(remembered).toHaveLength(0);
  });

  it("is idempotent via the watermark — a second run ingests nothing new", () => {
    failedTurn("op1", "2026-06-06T10:00:00.000Z", [["bash", "error"]]);
    const first = stubMemory();
    expect(ingestOperationalOutcomes(first.memory).ingested).toBe(1);

    const second = stubMemory();
    expect(ingestOperationalOutcomes(second.memory).ingested).toBe(0);

    // a NEW failure after the watermark is picked up
    failedTurn("op2", "2026-06-06T11:00:00.000Z", [["web_fetch", "error"]]);
    const third = stubMemory();
    expect(ingestOperationalOutcomes(third.memory).ingested).toBe(1);
    expect(third.remembered[0].content).toContain("web_fetch");
  });
});
