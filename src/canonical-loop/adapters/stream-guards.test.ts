// Degenerate-stream guard: trips on verbatim loops, symbol soup, and
// single-char floods; must NEVER trip on legit prose, code, JSON, markdown
// tables, or non-Latin scripts. False positives kill healthy local answers,
// so the negative cases here are the contract as much as the positives.

import { describe, it, expect } from "vitest";
import { createDegenerateStreamGuard, type StreamGuardVerdict } from "./stream-guards.js";

/** Feed `text` in `deltaSize`-char deltas (streaming-realistic) and return
 *  the first tripped verdict, or the final untripped one. */
function feedAll(text: string, deltaSize = 24): StreamGuardVerdict {
  const guard = createDegenerateStreamGuard();
  for (let i = 0; i < text.length; i += deltaSize) {
    const v = guard.feed(text.slice(i, i + deltaSize));
    if (v.tripped) return v;
  }
  return { tripped: false };
}

// ── Positives — degenerate output must trip ────────────────────────────────

describe("degenerate stream guard — trips", () => {
  it("trips on a 100-char block repeated 3+ times (the verbatim-loop incident shape)", () => {
    const block =
      "I keep circling back to the same conclusion about the request you made, which is that the answer "; // 98 chars
    expect(block.length).toBeGreaterThanOrEqual(80);
    const v = feedAll(block.repeat(8));
    expect(v.tripped).toBe(true);
    if (v.tripped) expect(v.reason).toMatch(/tail repetition/);
  });

  it("trips on symbol soup (letters+digits < 8%, symbols > 60%)", () => {
    const soup = "!@#$%^&*()_+~<>?/\\|=-[]{};:'\",.".repeat(40);
    const v = feedAll(soup);
    expect(v.tripped).toBe(true);
    if (v.tripped) expect(v.reason).toMatch(/garble/);
  });

  it("trips on a single-symbol flood", () => {
    for (const flood of [".".repeat(800), "!".repeat(800)]) {
      const v = feedAll(flood);
      expect(v.tripped).toBe(true);
      if (v.tripped) expect(v.reason).toMatch(/garble/);
    }
  });

  it("trips on a single-letter flood", () => {
    const v = feedAll("a".repeat(800));
    expect(v.tripped).toBe(true);
    if (v.tripped) expect(v.reason).toMatch(/garble/);
  });

  it("verdict is sticky once tripped", () => {
    const guard = createDegenerateStreamGuard();
    let tripped = false;
    for (let i = 0; i < 40 && !tripped; i++) tripped = guard.feed("?".repeat(32)).tripped;
    expect(tripped).toBe(true);
    // Healthy text afterwards must not un-trip the verdict.
    expect(guard.feed("perfectly normal prose now").tripped).toBe(true);
  });
});

// ── Negatives — legit output must NOT trip ─────────────────────────────────

describe("degenerate stream guard — never trips on legit output", () => {
  it("5KB of varied prose", () => {
    let prose = "";
    for (let i = 0; prose.length < 5000; i++) {
      prose += `Measurement ${i} landed near ${(i * 37) % 101} units, which reviewers found ${
        i % 2 ? "acceptable" : "surprising"
      } given the calibration drift noted earlier in run ${i % 7}. `;
    }
    expect(feedAll(prose).tripped).toBe(false);
  });

  it("code with braces and repeated structure", () => {
    let code = "export function dispatch(handlers) {\n";
    for (let i = 0; i < 40; i++) {
      code += `  if (event.kind === "kind_${i}") { return handlers.on${i}({ id: ${i}, retries: ${i % 3} }); }\n`;
    }
    code += "  return null;\n}\n";
    expect(feedAll(code).tripped).toBe(false);
  });

  it("JSON array dump (varied objects)", () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ id: i, name: `item-${i}`, qty: (i * 13) % 7 }));
    expect(feedAll(JSON.stringify(rows)).tripped).toBe(false);
  });

  it("uniform numeric array (low-alphabet repetition is data, not a loop)", () => {
    const zeros = "[" + "0, ".repeat(900) + "0]";
    expect(feedAll(zeros).tripped).toBe(false);
  });

  it("whitespace-separated zero matrix (raw runs, not compacted runs, decide dominance)", () => {
    // numpy-style dump: dominance of `0` is real (~50% of non-space chars),
    // but no `0` ever RUNS in the raw text — compaction must not be allowed
    // to manufacture the run.
    let matrix = "";
    for (let r = 0; r < 40; r++) matrix += "0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n";
    expect(feedAll(matrix).tripped).toBe(false);
  });

  it("CJK text (letters via \\p{L}, so it is never 'garble')", () => {
    let cjk = "";
    for (let i = 0; cjk.length < 2400; i++) {
      cjk += `第${i}条：今天讨论了本地模型的性能问题，结论是显存带宽比核心数量更重要，编号${(i * 7) % 53}的实验支持这一点。`;
    }
    expect(feedAll(cjk).tripped).toBe(false);
  });

  it("markdown table — including a skinny numeric one (pipe-dominated but pipes never run)", () => {
    let skinny = "| n |\n|---|\n";
    for (let i = 0; i < 300; i++) skinny += `| ${i} |\n`;
    expect(feedAll(skinny).tripped).toBe(false);

    let wide = "| name | qty | status | notes |\n|------|-----|--------|-------|\n";
    for (let i = 0; i < 40; i++) {
      wide += `| item-${i} | ${i % 9} | ${i % 2 ? "ok" : "todo"} | batch ${(i * 11) % 17} pending review |\n`;
    }
    expect(feedAll(wide).tripped).toBe(false);
  });

  it("short replies never even reach a check", () => {
    const guard = createDegenerateStreamGuard();
    expect(guard.feed("ok!").tripped).toBe(false);
    expect(guard.feed("...".repeat(20)).tripped).toBe(false); // 60 chars — under the 512 cadence
  });
});
