/**
 * Shared-state ownership pins for src/memory (audit chunk C4).
 *
 * Every case here is ADDITIVE and changes no behavior. Cases labelled
 * CHARACTERIZATION deliberately assert what the code does TODAY where that
 * behavior is a filed hazard — a fix must flip them on purpose, not by
 * accident. Cases labelled INVARIANT pin something the audit verified as
 * correct and that nothing else was pinning.
 *
 * Scope: module-level mutable state in src/memory that is keyed by (or is
 * missing a key for) a session, and the pure key-derivers around it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeMemorySafely, getLastWriteTick, getMemoryWriteTick } from "./write-safely.js";
import { createInternalMemoryContext } from "./promotion-gate.js";
import {
  TAINTED_PROMOTION_QUOTA,
  clearTaintedPromotionQuota,
  taintedPromotionQuotaExhausted,
  stampTaintedModelPromotion,
  splitBatchPromotionContext,
  promotionContextFromToolArgs,
  joinFactsForPromotion,
  type MemoryPromotionRequest,
} from "./promotion-gate.js";
import { MAX_FACTS_PER_CALL } from "./fact-split.js";
import { factTrustSuffix, TAINTED_FACT_SOURCE_PREFIX } from "./fact-provenance-label.js";
import { boostNudgePriority, resetSession as resetCurateNudge } from "./curate-nudge.js";
import { _internals as coalescer } from "./extraction-coalescer.js";
import { requestEndOfTurnExtraction } from "./extraction-coalescer.js";
import { updateProjectBrief, _resetProjectBriefLocksForTest } from "./project-brief.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-c4-ownership-"));
});

afterEach(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

function landToolWrite(name: string): void {
  const target = join(tempDir, name);
  const content = `- ${name} content line\n`;
  writeMemorySafely({
    content,
    source: "tool",
    target,
    mode: "overwrite",
    promotion: createInternalMemoryContext(content, target, "c4-test"),
  });
}

// ───────────────────────────────────────────────────────────────────────────
// The memory write clock (write-safely.ts:106-107) has NO session dimension.
// ───────────────────────────────────────────────────────────────────────────

describe("write clock / extraction coalescer ownership", () => {
  it("INVARIANT: the write clock is process-global and carries no session key", () => {
    const before = getLastWriteTick("tool");
    landToolWrite("some-other-sessions-write.md");
    // getLastWriteTick's only argument is the SOURCE. There is no overload
    // that takes a session, so no reader can ask "did THIS session write?".
    expect(getLastWriteTick("tool")).toBeGreaterThan(before);
    expect(getMemoryWriteTick()).toBeGreaterThanOrEqual(getLastWriteTick("tool"));
  });

  it("CHARACTERIZATION (C4-H2): one session's `tool` write cancels an UNRELATED session's end-of-turn pass", async () => {
    coalescer.reset();
    const victim = "c4-victim-session";
    resetCurateNudge(victim);
    boostNudgePriority(victim, "explicit-remember");

    // The victim's coalescer state (and therefore its cursor) exists first.
    const state = coalescer.getState(victim);
    const cursorBefore = state.cursorTick;

    // A COMPLETELY DIFFERENT writer lands a `tool`-source memory write. In
    // production this is another chat's `remember`, the nightly dream runner,
    // consolidation, compression, project_brief_update or a sync pull — all
    // of which stamp source "tool" with no session attached.
    landToolWrite("foreign-writer.md");
    expect(getLastWriteTick("tool")).toBeGreaterThan(cursorBefore);

    requestEndOfTurnExtraction({
      sessionId: victim,
      userMessage: "hello",
      assistantReply: "hi",
      turnMessages: [],
      memory: {} as never,
    });
    await state.chain;

    // The run was SKIPPED as "the main agent already curated memory" and the
    // cursor advanced — even though this session's agent wrote nothing.
    // `memory` above is a bare object: had the pass actually run it would have
    // thrown inside runOne (caught, cursor NOT advanced).
    expect(state.cursorTick).toBeGreaterThan(cursorBefore);
    coalescer.reset();
    resetCurateNudge(victim);
  });

  it("INVARIANT: only the `tool` source drives the skip — other sources are ignored", async () => {
    coalescer.reset();
    const sess = "c4-eot-source-session";
    resetCurateNudge(sess);
    boostNudgePriority(sess, "explicit-remember");
    const state = coalescer.getState(sess);
    const cursorBefore = state.cursorTick;

    const target = join(tempDir, "eot-write.md");
    const content = "- eot content\n";
    writeMemorySafely({
      content,
      source: "eot",
      target,
      mode: "overwrite",
      promotion: createInternalMemoryContext(content, target, "c4-test"),
    });

    // The `eot` write moved the global clock but NOT the "tool" lane, so the
    // skip condition (getLastWriteTick("tool") > cursor) is unchanged. This is
    // what makes the previous case a SOURCE-attribution bug and not a
    // clock-resolution one.
    expect(getLastWriteTick("tool")).toBeLessThanOrEqual(cursorBefore);
    coalescer.reset();
    resetCurateNudge(sess);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Tainted-promotion quota (promotion-gate.ts:346-370).
// ───────────────────────────────────────────────────────────────────────────

describe("tainted promotion quota ownership", () => {
  const request = (sessionId: string, content: string): MemoryPromotionRequest => ({
    content,
    target: "memory:retain",
    source: "model-tool:remember",
    sessionId,
    provenance: "model-declared:inference",
    confidence: 0.6,
    origin: "assistant",
  });

  it("INVARIANT: writer and reader derive the SAME quota key", () => {
    const sess = "c4-quota-key";
    clearTaintedPromotionQuota(sess);
    expect(taintedPromotionQuotaExhausted(sess)).toBe(false);
    for (let i = 0; i < TAINTED_PROMOTION_QUOTA; i++) {
      stampTaintedModelPromotion({}, request(sess, `fact ${i}`));
    }
    expect(taintedPromotionQuotaExhausted(sess)).toBe(true);
    // A different session is untouched — the counter really is per-session.
    expect(taintedPromotionQuotaExhausted(`${sess}-other`)).toBe(false);
    clearTaintedPromotionQuota(sess);
  });

  it("CHARACTERIZATION (C4-H3): the quota counts CALLS, not facts — a batch spends one unit for many facts", () => {
    const sess = "c4-quota-batch";
    clearTaintedPromotionQuota(sess);

    const facts = Array.from({ length: MAX_FACTS_PER_CALL }, (_, i) => `batched fact number ${i}`);
    const stampedContent = joinFactsForPromotion(facts);
    const args: Record<string, unknown> = {};
    const req = request(sess, stampedContent);
    stampTaintedModelPromotion(args, req);

    // ONE stamp = ONE quota unit, regardless of how many facts ride it.
    expect(taintedPromotionQuotaExhausted(sess)).toBe(false);

    // The sink then derives one capability per fact WITHOUT touching the quota.
    const ctx = promotionContextFromToolArgs(args, {
      content: stampedContent,
      target: "memory:retain",
      source: "model-tool:remember",
      sessionId: sess,
      provenance: "model-declared:inference",
      confidence: 0.6,
    });
    const derived = splitBatchPromotionContext(ctx, true);
    expect(derived.facts.length).toBe(MAX_FACTS_PER_CALL);
    expect(derived.contexts.length).toBe(MAX_FACTS_PER_CALL);

    // So the real per-session ceiling on unreviewed tainted facts is
    // TAINTED_PROMOTION_QUOTA * MAX_FACTS_PER_CALL, not TAINTED_PROMOTION_QUOTA.
    // The two constants happen to be equal today, which hides the product.
    expect(TAINTED_PROMOTION_QUOTA * MAX_FACTS_PER_CALL).toBeGreaterThan(TAINTED_PROMOTION_QUOTA);
    clearTaintedPromotionQuota(sess);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Recall-side trust labels (fact-provenance-label.ts) vs the source_file
// values memory/tools/facts.ts:47-60 actually writes.
// ───────────────────────────────────────────────────────────────────────────

describe("fact trust label coverage", () => {
  // These two strings are exactly what authorizedSource() emits for the
  // ordinary model-save path (facts.ts:59-60).
  const AUTO_CLEAN = "agent-tool:auto-model-clean-inference";
  const HUMAN_APPROVED = "agent-tool:approved-model-declared-inference";

  it("INVARIANT: a tainted save keeps its untrusted label at recall", () => {
    const label = factTrustSuffix(`${TAINTED_FACT_SOURCE_PREFIX}-inference`);
    expect(label).toContain("UNTRUSTED");
    expect(label).toContain("taint=tainted");
  });

  it("CHARACTERIZATION (C4-H4): the two labels the live save path writes have NO case — both fall to `legacy`", () => {
    const autoLabel = factTrustSuffix(AUTO_CLEAN);
    const approvedLabel = factTrustSuffix(HUMAN_APPROVED);
    expect(autoLabel).toContain("source_type=legacy");
    expect(approvedLabel).toContain("source_type=legacy");
    // An auto-allowed (never human-reviewed) fact and a human-approved one are
    // therefore INDISTINGUISHABLE at recall, even though authorizedSource's
    // own comment says "the audit label must not claim approval that never
    // happened" and preserves the distinction in source_file.
    expect(autoLabel).toBe(approvedLabel);
    // It is also weaker than the label a plain declared inference gets.
    expect(factTrustSuffix("agent-tool:inference")).toContain("unverified inference");
    expect(autoLabel).not.toContain("unverified inference");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Profile-file writers: read-modify-write with a full overwrite and no lock,
// next to project-brief.ts's identically-shaped writer that HAS one.
// ───────────────────────────────────────────────────────────────────────────

describe("profile-file write ownership", () => {
  it("CHARACTERIZATION (C4-H1): concurrent read-modify-write of a profile file loses the loser's whole edit", () => {
    const target = join(tempDir, "USER.md");
    writeFileSync(target, "# About Me\n\n- Name: Ada\n", "utf-8");

    // Writer A reads. (In production an awaited LLM dedupe call sits here.)
    const aRead = readFileSync(target, "utf-8");
    // Writer B reads, edits and lands its overwrite inside A's window.
    const bRead = readFileSync(target, "utf-8");
    const bUpdated = `${bRead}- Location: Berlin\n`;
    writeMemorySafely({
      content: bUpdated,
      source: "tool",
      target,
      mode: "overwrite",
      promotion: createInternalMemoryContext(bUpdated, target, "c4-writer-b"),
    });
    expect(readFileSync(target, "utf-8")).toContain("Location: Berlin");

    // A now lands its own overwrite from the stale read.
    const aUpdated = `${aRead}- Role: Engineer\n`;
    writeMemorySafely({
      content: aUpdated,
      source: "tool",
      target,
      mode: "overwrite",
      promotion: createInternalMemoryContext(aUpdated, target, "c4-writer-a"),
    });

    const final = readFileSync(target, "utf-8");
    expect(final).toContain("Role: Engineer");
    // B's durable memory is GONE. mode:"overwrite" is a full replace and
    // nothing serializes the read→write pair for profile files.
    expect(final).not.toContain("Location: Berlin");
  });

  it("INVARIANT: project briefs — the same read-modify-write shape — ARE serialized by withProjectLock", async () => {
    _resetProjectBriefLocksForTest();
    const memDir = join(tempDir, "brief-mem");
    const briefTarget = join(memDir, "projects", "c4proj", "PROJECT.md");
    const [first, second] = await Promise.all([
      updateProjectBrief("c4proj", "## Alpha\nfirst change", {
        memDir,
        title: "C4 Proj",
        promotion: createInternalMemoryContext("## Alpha\nfirst change", briefTarget, "c4-brief-a"),
      }),
      updateProjectBrief("c4proj", "## Beta\nsecond change", {
        memDir,
        title: "C4 Proj",
        promotion: createInternalMemoryContext("## Beta\nsecond change", briefTarget, "c4-brief-b"),
      }),
    ]);
    // Whichever ran second observed the first's write — no lost update.
    const merged = first.length > second.length ? first : second;
    expect(merged).toContain("Alpha");
    expect(merged).toContain("Beta");
    _resetProjectBriefLocksForTest();
  });
});
