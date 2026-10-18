/**
 * The resolver drops a new fact only on an explicit NOOP verdict.
 *
 * retainSmart skips a NOOP, so any resolver outcome that is not a decision
 * (no answer, an unreadable answer, UPDATE/DELETE naming no real candidate)
 * must keep the fact. Background calls run on the chat model now, and a busy
 * chat model times them out: a "no answer" read as NOOP would discard what
 * the user just said.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../llm-dispatch.js", () => ({ dispatch: vi.fn() }));

import { dispatch } from "../llm-dispatch.js";
import { resolveFact, type ResolverCandidate } from "./resolver.js";
import { MemoryIndex } from "./index.js";
import { authorizeTestFactMutations } from "./test-promotion.test-helper.js";

const CANDIDATES: ResolverCandidate[] = [
  { id: 7, content: "Odalys keeps her sailboat at slip 14 in Port Avila", kind: "world", timestamp: 1 },
];

describe("resolveFact keeps the new fact unless the model said NOOP", () => {
  beforeEach(() => vi.mocked(dispatch).mockReset());

  it("no answer (timeout, no model) → ADD", async () => {
    vi.mocked(dispatch).mockResolvedValue(null);
    expect((await resolveFact("Odalys moved the boat to slip 31", CANDIDATES)).op).toBe("ADD");
  });

  it("an unreadable answer → ADD", async () => {
    vi.mocked(dispatch).mockResolvedValue("I think this is probably fine?");
    expect((await resolveFact("Odalys moved the boat to slip 31", CANDIDATES)).op).toBe("ADD");
  });

  it("UPDATE naming no real candidate → ADD, and the old fact is left alone", async () => {
    vi.mocked(dispatch).mockResolvedValue("OP=UPDATE TARGET=99 REASON=refines it");
    const decision = await resolveFact("Odalys moved the boat to slip 31", CANDIDATES);
    expect(decision.op).toBe("ADD");
    expect(decision.targetId).toBeUndefined();
  });

  it("an explicit NOOP verdict is still a NOOP", async () => {
    vi.mocked(dispatch).mockResolvedValue("OP=NOOP TARGET=- REASON=duplicate of candidate 1");
    expect((await resolveFact("Odalys keeps her sailboat at slip 14", CANDIDATES)).op).toBe("NOOP");
  });

  it("an explicit UPDATE with a real target is still an UPDATE", async () => {
    vi.mocked(dispatch).mockResolvedValue("OP=UPDATE TARGET=7 REASON=new slip");
    expect(await resolveFact("Odalys moved the boat to slip 31", CANDIDATES)).toMatchObject({ op: "UPDATE", targetId: 7 });
  });
});

describe("retainSmart stores the fact when the resolver gets no answer", () => {
  let tempDir: string;
  let memory: MemoryIndex;

  beforeEach(() => {
    vi.mocked(dispatch).mockReset();
    tempDir = mkdtempSync(join(tmpdir(), "lax-resolver-seam-"));
    mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
    mkdirSync(join(tempDir, "memory", "session-summaries"), { recursive: true });
    memory = new MemoryIndex(tempDir, { minScore: -1 });
    authorizeTestFactMutations(memory);
  });

  afterEach(() => {
    try { memory.close(); } catch { /* temp index; already closed is fine */ }
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
  });

  it("a similar fact exists and the model never answers: the new statement is kept", async () => {
    memory.retain("- W @Odalys keeps her sailboat, the Kestrel Nine, at slip 14 in Port Avila", "daily.md");
    vi.mocked(dispatch).mockResolvedValue(null);

    const { facts, decisions } = await memory.retainSmart(
      "- W @Odalys keeps the Kestrel Nine at slip 31 in Port Avila now", "auto-extract",
    );

    expect(vi.mocked(dispatch)).toHaveBeenCalled();
    expect(decisions.map((d) => d.op)).toEqual(["ADD"]);
    expect(facts.map((f) => f.content)).toEqual([expect.stringContaining("slip 31")]);
  });
});
