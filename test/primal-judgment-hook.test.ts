/**
 * Judgment hook unit tests — exercise the hook with a stubbed LlmCall
 * so the tests are deterministic and don't spawn a real provider
 * request. Covers:
 *   - constitution + CHANGED file reads
 *   - JSON response parsing (violation:true / violation:false / malformed)
 *   - timeout behavior (fail-open returns null)
 *   - empty CHANGED list short-circuit
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLlmJudgmentHook,
  parseJudgmentResponse,
  buildJudgmentPrompt,
  type LlmCall,
} from "../src/primal-auto-build/chunk-review/judgment-hook.js";
import type { ParsedChunk } from "../src/primal-auto-build/plan-parser.js";
import { parseChunkReport } from "../src/primal-auto-build/chunk-review/report-parser.js";

let dir: string;

const sampleChunk: ParsedChunk = {
  number: 12,
  title: "Public booking page UI",
  phase: "Phase D",
  klass: "leaf",
  slice: "/[host]/[type] route with slot picker",
  dependsOn: [10, 11],
  scenarios: "1, 2, 3, 7",
  doneWhen: "page renders, hides conflicting slots, submits to server action.",
  rawSection: "",
};

const sampleReport = parseChunkReport(
  "STATUS: done\n" +
  "DONE_WHEN: met\n" +
  "CHANGED: app/page.tsx, lib/render.ts\n" +
  "TESTS: 18/18\n" +
  "NEW_FAILURES: none\n" +
  "PRE_EXISTING_FAILURES: none\n" +
  "SPEC_GAPS: none\n" +
  "LAUNCH_READINESS: none\n" +
  "NOTE: page renders, no issues."
);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "primal-judgment-test-"));
});

afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });

describe("parseJudgmentResponse", () => {
  it("returns null on violation:false", () => {
    expect(parseJudgmentResponse('{"violation": false, "rule": "", "pattern": "", "specGap": "", "reasoning": ""}')).toBeNull();
  });

  it("returns the spec gap on violation:true", () => {
    const r = parseJudgmentResponse(
      '{"violation": true, "rule": "no silent failures", "pattern": "renders stale data", "specGap": "Must show stale notice on degraded.", "reasoning": "Booking page renders availability from degraded calendars without notice."}'
    );
    expect(r).not.toBeNull();
    expect(r!.specGap).toBe("Must show stale notice on degraded.");
    expect(r!.reasoning).toContain("no silent failures");
  });

  it("returns null when violation:true but specGap is empty", () => {
    expect(parseJudgmentResponse('{"violation": true, "rule": "x", "pattern": "y", "specGap": "", "reasoning": "z"}')).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(parseJudgmentResponse("not json at all")).toBeNull();
    expect(parseJudgmentResponse('{"violation": true, "specGap": ')).toBeNull();
  });

  it("tolerates surrounding prose", () => {
    const r = parseJudgmentResponse(
      'Sure, here you go:\n{"violation": true, "rule": "x", "pattern": "y", "specGap": "Add X.", "reasoning": "z"}\nThat\'s my verdict.'
    );
    expect(r).not.toBeNull();
    expect(r!.specGap).toBe("Add X.");
  });
});

describe("buildJudgmentPrompt", () => {
  it("includes chunk slice, done-when, NOTE, constitution, and CHANGED snippets", () => {
    const prompt = buildJudgmentPrompt({
      chunk: sampleChunk,
      report: sampleReport,
      constitution: "Rule: no silent failures.",
      changedSnippets: "### app/page.tsx\n\n```\nexport function Page() {...}\n```",
    });
    expect(prompt).toContain("Public booking page UI");
    expect(prompt).toContain("page renders, hides conflicting slots");
    expect(prompt).toContain("page renders, no issues."); // NOTE
    expect(prompt).toContain("Rule: no silent failures.");
    expect(prompt).toContain("app/page.tsx");
    expect(prompt).toContain("Bias STRONGLY toward null");
  });

  it("handles empty constitution / snippets gracefully", () => {
    const prompt = buildJudgmentPrompt({
      chunk: sampleChunk, report: sampleReport, constitution: "", changedSnippets: "",
    });
    expect(prompt).toContain("(no constitution file found)");
    expect(prompt).toContain("(no CHANGED files readable)");
  });
});

describe("createLlmJudgmentHook — happy paths", () => {
  it("returns null when CHANGED is empty (short-circuit, no LLM call)", async () => {
    const llmCall = vi.fn(async () => "should not be called");
    const hook = createLlmJudgmentHook(llmCall as LlmCall);
    const emptyReport = parseChunkReport(
      "STATUS: done\nDONE_WHEN: met\nCHANGED: none\nTESTS: 0/0\nNEW_FAILURES: none\n" +
      "PRE_EXISTING_FAILURES: none\nSPEC_GAPS: none\nLAUNCH_READINESS: none\nNOTE: nothing changed."
    );
    const result = await hook({ chunk: sampleChunk, report: emptyReport, projectDir: dir });
    expect(result).toBeNull();
    expect(llmCall).not.toHaveBeenCalled();
  });

  it("fires when CHANGED + constitution exist + model says violation", async () => {
    mkdirSync(join(dir, "spec"));
    writeFileSync(join(dir, "spec", "constitution.md"), "# Constitution\n\n8. No silent failures affecting the user.\n");
    mkdirSync(join(dir, "app"));
    writeFileSync(join(dir, "app", "page.tsx"), "export function Page() { return <SlotPicker host={host}/>; }");
    mkdirSync(join(dir, "lib"));
    writeFileSync(join(dir, "lib", "render.ts"), "export function render() { /* renders availability */ }");

    let receivedPrompt = "";
    const llmCall: LlmCall = async (prompt) => {
      receivedPrompt = prompt;
      return JSON.stringify({
        violation: true,
        rule: "Constitution #8 — no silent failures",
        pattern: "renders availability from degraded calendar connections without a stale-data notice",
        specGap: "If any of the host's calendar connections is in degraded state, the public booking page must show a visible 'showing last-synced availability' notice.",
        reasoning: "The slot picker has no awareness of degraded connections; renders cached data silently.",
      });
    };

    const hook = createLlmJudgmentHook(llmCall);
    const result = await hook({ chunk: sampleChunk, report: sampleReport, projectDir: dir });

    expect(result).not.toBeNull();
    expect(result!.specGap).toContain("degraded state");
    expect(result!.reasoning).toContain("Constitution #8");
    // Prompt should have included the constitution and CHANGED snippets.
    expect(receivedPrompt).toContain("No silent failures");
    expect(receivedPrompt).toContain("app/page.tsx");
    expect(receivedPrompt).toContain("lib/render.ts");
  });
});

describe("createLlmJudgmentHook — fail-open paths", () => {
  it("returns null when model responds with violation:false (no false-positive)", async () => {
    mkdirSync(join(dir, "spec"));
    writeFileSync(join(dir, "spec", "constitution.md"), "no silent failures\n");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "ok.ts"), "// fine code");

    const cleanReport = parseChunkReport(
      "STATUS: done\nDONE_WHEN: met\nCHANGED: src/ok.ts\nTESTS: 5/5\nNEW_FAILURES: none\n" +
      "PRE_EXISTING_FAILURES: none\nSPEC_GAPS: none\nLAUNCH_READINESS: none\nNOTE: ok"
    );
    const llmCall: LlmCall = async () => '{"violation": false, "rule": "", "pattern": "", "specGap": "", "reasoning": "no issues"}';
    const hook = createLlmJudgmentHook(llmCall);
    expect(await hook({ chunk: sampleChunk, report: cleanReport, projectDir: dir })).toBeNull();
  });

  it("returns null when the LLM call throws", async () => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "ok.ts"), "ok");
    const llmCall: LlmCall = async () => { throw new Error("network down"); };
    const hook = createLlmJudgmentHook(llmCall);
    const reportWithFile = parseChunkReport(
      "STATUS: done\nDONE_WHEN: met\nCHANGED: src/ok.ts\nTESTS: 5/5\nNEW_FAILURES: none\n" +
      "PRE_EXISTING_FAILURES: none\nSPEC_GAPS: none\nLAUNCH_READINESS: none\nNOTE: ok"
    );
    expect(await hook({ chunk: sampleChunk, report: reportWithFile, projectDir: dir })).toBeNull();
  });

  it("returns null when LLM response is unparseable", async () => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "ok.ts"), "ok");
    const llmCall: LlmCall = async () => "I'm sorry, I can't comply with that request.";
    const hook = createLlmJudgmentHook(llmCall);
    const reportWithFile = parseChunkReport(
      "STATUS: done\nDONE_WHEN: met\nCHANGED: src/ok.ts\nTESTS: 5/5\nNEW_FAILURES: none\n" +
      "PRE_EXISTING_FAILURES: none\nSPEC_GAPS: none\nLAUNCH_READINESS: none\nNOTE: ok"
    );
    expect(await hook({ chunk: sampleChunk, report: reportWithFile, projectDir: dir })).toBeNull();
  });
});

// vi is available as a vitest global; import-style guard:
import { vi } from "vitest";
