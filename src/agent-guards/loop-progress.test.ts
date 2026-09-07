import { describe, it, expect } from "vitest";
import {
  detectCycle, mutationTargetKey, noteTurnShape, noveltySignature, rememberNovelResult,
  RESULT_SIG_MEMORY, turnShapeKey,
  type CycleTurn,
} from "./loop-progress.js";
import { checkToolLoops, noteToolResults, createLoopState } from "./loop-detection.js";

/**
 * Regression suite for the three progress signals, anchored where possible on
 * a RECORDED run rather than synthetic shapes.
 *
 * The fixture below is the real turn-by-turn tool shape of
 * op_chat_turn_4808572060514f75 (turns 39-119 of a 160-turn chat op that
 * livelocked): the agent rebuilt a scratch harness, screenshotted it, re-
 * fetched two unchanged prod URLs, and started over — twelve times, learning
 * nothing. Every detector in the guard missed it. Synthetic loops are easy to
 * catch; this is the shape a real model actually produces, jitter included.
 */
const LIVELOCK_SHAPES = [
  "http_request,http_request", "write", "write", "browser", "browser", "browser", "browser",
  "http_request,http_request", "http_request,http_request", "write", "write", "browser", "browser",
  "http_request,http_request", "write", "write", "browser", "browser", "browser", "bash",
  "delete_file", "http_request", "http_request", "write", "write", "browser", "browser",
  "http_request,http_request", "write", "write", "browser", "browser", "http_request,http_request",
  "browser", "browser", "browser", "browser", "browser", "http_request,http_request", "write",
  "write", "browser", "browser", "browser", "http_request,http_request", "write", "write",
  "browser", "browser", "http_request,http_request", "write", "write", "browser", "browser",
  "http_request,http_request", "write", "write", "browser", "browser", "http_request,http_request",
  "write", "write", "browser", "browser", "http_request,http_request", "write", "write",
  "browser", "browser", "browser", "http_request,http_request", "write", "write", "browser",
  "browser", "browser", "http_request,http_request",
];

describe("noveltySignature — volatile spans are not information", () => {
  it("two screenshots of the same page collapse to one signature", () => {
    const shot = (blob: string, ms: number) =>
      `[ok, duration_ms=${ms}] screenshot: data:image/png;base64,${blob}`;
    const a = shot("A".repeat(128), 51);
    const b = shot("B".repeat(128), 4231);
    expect(a).not.toEqual(b);
    expect(noveltySignature(a)).toBe(noveltySignature(b));
  });

  it("re-navigated DOM snapshots differing only in element refs collapse", () => {
    const snap = (ref: number, id: string) =>
      `Page snapshot --- <<<EXTERNAL id="${id}">>> [${ref}] <button>Book now</button>`;
    expect(noveltySignature(snap(1936, "e20278e750568a66")))
      .toBe(noveltySignature(snap(4127, "aa118bc750f0ab21")));
  });

  it("genuinely different content still reads as novel", () => {
    expect(noveltySignature("min-width: 768px")).not.toBe(noveltySignature("min-width: 0"));
  });

  it("a changed byte count stays novel — response size is real information", () => {
    const a = "[ok, status=200, bytes=20359] text/css";
    const b = "[ok, status=200, bytes=21044] text/css";
    expect(noveltySignature(a)).not.toBe(noveltySignature(b));
  });
});

describe("rememberNovelResult — a monotonic counter beside a capped set", () => {
  it("counts every novel result forever while the set stays bounded", () => {
    const state = { seenResultSigs: new Set<string>(), progressTotal: 0 };
    for (let i = 0; i < RESULT_SIG_MEMORY + 100; i++) rememberNovelResult(state, `sig-${i}`);
    expect(state.seenResultSigs.size).toBe(RESULT_SIG_MEMORY);
    expect(state.progressTotal).toBe(RESULT_SIG_MEMORY + 100);
    // FIFO: the oldest signatures were the ones evicted.
    expect(state.seenResultSigs.has("sig-0")).toBe(false);
    expect(state.seenResultSigs.has(`sig-${RESULT_SIG_MEMORY + 99}`)).toBe(true);
  });

  it("advances through noteToolResults only on a NOVEL result", () => {
    const state = createLoopState();
    const call = [{ name: "search", arguments: "{}" }];
    noteToolResults(call, state, [{ content: "alpha", status: "ok" }]);
    noteToolResults(call, state, [{ content: "alpha", status: "ok" }]); // repeat — not novel
    noteToolResults(call, state, [{ content: "beta", status: "ok" }]);
    noteToolResults(call, state, [{ content: "failed", status: "error" }]); // failures never count
    expect(state.progressTotal).toBe(2);
    expect(state.seenResultSigs.size).toBe(2);
  });

  it("also advances on a NEW mutation target, while the novelty set keeps excluding the write's text", () => {
    const state = createLoopState();
    const write = (path: string, content: string) =>
      [{ name: "write", arguments: JSON.stringify({ path, content }) }];
    noteToolResults(write("/w/a.ts", "v1"), state, [{ content: "ok", status: "ok" }]);
    noteToolResults(write("/w/a.ts", "v2"), state, [{ content: "ok", status: "ok" }]); // same target — not progress
    noteToolResults(write("/w/b.ts", "v1"), state, [{ content: "ok", status: "ok" }]);
    noteToolResults(write("/w/c.ts", "v1"), state, [{ content: "ok", status: "error" }]); // failed write — never counts
    expect(state.progressTotal).toBe(2);
    expect(state.seenMutationTargets.size).toBe(2);
    expect(state.seenResultSigs.size).toBe(0);
  });

  it("is volatility-normalized like the set — two screenshots of one page count once", () => {
    const state = createLoopState();
    const call = [{ name: "browser", arguments: "{}" }];
    const shot = (blob: string, ms: number) => `[ok, duration_ms=${ms}] screenshot: data:image/png;base64,${blob}`;
    noteToolResults(call, state, [{ content: shot("A".repeat(128), 51), status: "ok" }]);
    noteToolResults(call, state, [{ content: shot("B".repeat(128), 4231), status: "ok" }]);
    expect(state.progressTotal).toBe(1);
  });

  // The checkpoint predicate's regression, at the guard level: past the cap,
  // the set's size is a constant while the counter keeps telling the truth.
  it("keeps counting past the cap where seenResultSigs.size has gone flat", () => {
    const state = createLoopState();
    const call = [{ name: "search", arguments: "{}" }];
    for (let i = 0; i < 300; i++) {
      noteToolResults(call, state, [{ content: `distinct result ${i}`, status: "ok" }]);
    }
    const sizeAt300 = state.seenResultSigs.size;
    for (let i = 300; i < 340; i++) {
      noteToolResults(call, state, [{ content: `distinct result ${i}`, status: "ok" }]);
    }
    expect(state.seenResultSigs.size).toBe(sizeAt300); // flat — the lie
    expect(state.progressTotal).toBe(340);          // the truth
  });
});

describe("mutationTargetKey — progress is a new target, not new bytes", () => {
  const call = (name: string, args: unknown) => ({ name, arguments: JSON.stringify(args) });

  it("rewriting one file with different content is the same target", () => {
    const a = mutationTargetKey(call("write", { path: "/w/_mt.html", content: "v1" }));
    const b = mutationTargetKey(call("write", { path: "/w/_mt.html", content: "v2-longer" }));
    expect(a).toBe(b);
    expect(a).not.toBeNull();
  });

  it("a different file is a different target", () => {
    expect(mutationTargetKey(call("write", { path: "/w/a.html", content: "x" })))
      .not.toBe(mutationTargetKey(call("write", { path: "/w/b.html", content: "x" })));
  });

  it("returns null when no target is identifiable, so callers keep the old key", () => {
    // The email_send case: coarsening this would collapse 32 distinct sends
    // into one repeated action and starve the no-progress budget.
    expect(mutationTargetKey(call("email_send", { to: "user@example.com" }))).toBeNull();
    expect(mutationTargetKey({ name: "write", arguments: "not json" })).toBeNull();
  });
});

describe("detectCycle — circles, not stutters", () => {
  const build = (shapes: string[], novel = false): CycleTurn[] => {
    const w: CycleTurn[] = [];
    for (const s of shapes) noteTurnShape(w, s, novel);
    return w;
  };
  const lap = ["http_request", "write", "browser"];

  it("finds a repeating multi-step procedure over a novelty-free span", () => {
    const hit = detectCycle(build([...lap, ...lap, ...lap]));
    expect(hit).toEqual({ period: 3, repeats: 3 });
  });

  it("does not fire while the span is still producing new information", () => {
    expect(detectCycle(build([...lap, ...lap, ...lap], true))).toBeNull();
  });

  it("does not fire on a constant window — that is the other detectors' job", () => {
    expect(detectCycle(build(Array(20).fill("web_search")))).toBeNull();
  });

  it("does not fire below the repeat floor", () => {
    expect(detectCycle(build([...lap, ...lap]))).toBeNull();
  });

  it("weak models trip a period earlier", () => {
    expect(detectCycle(build([...lap, ...lap]), { modelTier: "weak" }))
      .toEqual({ period: 3, repeats: 2 });
  });

  it("finds the cycle in the RECORDED livelock trace", () => {
    const w: CycleTurn[] = [];
    let firstHitAt: number | null = null;
    LIVELOCK_SHAPES.forEach((shape, i) => {
      noteTurnShape(w, shape, false);
      if (firstHitAt === null && detectCycle(w)) firstHitAt = i;
    });
    expect(firstHitAt).not.toBeNull();
    // Fires well inside the window the real op burned to no effect.
    expect(firstHitAt!).toBeLessThan(LIVELOCK_SHAPES.length);
  });
});

describe("turnShapeKey", () => {
  it("keys on procedure, not arguments — a renamed scratch file is the same lap", () => {
    expect(turnShapeKey([{ name: "write" }, { name: "browser" }])).toBe("write,browser");
  });
});

describe("checkToolLoops — the recorded livelock is now caught", () => {
  /** Replay one turn: pre-dispatch check, then post-dispatch bookkeeping. */
  function replay(shapes: string[], result: (i: number) => string) {
    const state = createLoopState();
    for (let i = 0; i < shapes.length; i++) {
      const calls = shapes[i].split(",").map((name, j) => ({
        // Vary the arguments every lap exactly as the real run did (it renamed
        // its scratch harness each time) — nothing here repeats adjacently.
        name,
        arguments: JSON.stringify({ path: `/w/_scratch-${i}-${j}.html`, url: `https://x/${i}` }),
      }));
      const verdict = checkToolLoops(calls, state, { modelTier: "strong", nudgeOnly: true });
      if (verdict.nudge || verdict.abort) return { firedAt: i, verdict };
      noteToolResults(calls, state, calls.map(() => ({ content: result(i), status: "ok" })), {
        modelTier: "strong",
      });
    }
    return { firedAt: null as number | null, verdict: null };
  }

  it("fires on the recorded shapes when every result is unchanged", () => {
    const hit = replay(LIVELOCK_SHAPES, () => "Both fixes are live on prod.");
    expect(hit.firedAt).not.toBeNull();
    expect(hit.verdict!.nudge).toBeTruthy();
  });

  it("stays silent when the same shapes keep surfacing new information", () => {
    // Same procedure, genuinely progressing work — must never be flagged.
    const hit = replay(LIVELOCK_SHAPES, i => `result number ${i} — new information`);
    expect(hit.firedAt).toBeNull();
  });
});
