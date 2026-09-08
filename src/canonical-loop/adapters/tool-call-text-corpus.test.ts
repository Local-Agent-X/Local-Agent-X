/**
 * Cross-seam contract test: every consumer of the ONE tool-call text
 * recognizer is run over the same corpus (tool-call-text-corpus.ts). One
 * describe per consumer, one `it` per case, so a failure names both the
 * consumer and the case id. Expectations come from the corpus only — a
 * consumer is never checked against another consumer's output.
 */

import { describe, expect, it } from "vitest";
import { findTextToolCallRanges } from "../public/tool-call-text.js";
import { extractToolCallsFromText } from "./tool-call-text-extractor.js";
import { CORPUS_TOOL_NAMES, TOOL_CALL_TEXT_CORPUS, type CorpusCase } from "./tool-call-text-corpus.js";
import { sanitizeModelOutput } from "../../providers/output-sanitize.js";
import {
  filterStreamDelta,
  sanitizeAssistantTextForRebuild,
  stripToolCallBlocks,
} from "../../anthropic-client/parse.js";

const WIRE_MARKER_PREFIX = "<wire-format-error:";

function toolsFor(c: CorpusCase): Set<string> {
  return new Set(c.tools ?? CORPUS_TOOL_NAMES);
}

function expectKeeps(out: string, keeps: readonly string[], label: string): void {
  for (const k of keeps) expect(out, `${label}: must keep ${JSON.stringify(k)}`).toContain(k);
}

function expectDrops(out: string, drops: readonly string[], label: string): void {
  for (const d of drops) expect(out, `${label}: must drop ${JSON.stringify(d)}`).not.toContain(d);
}

describe("tool-call text corpus: recognizer ranges (masked view)", () => {
  for (const c of TOOL_CALL_TEXT_CORPUS) {
    it(c.id, () => {
      const ranges = findTextToolCallRanges(c.text, toolsFor(c));
      expect(ranges, `${c.id}: masked range count`).toHaveLength(c.expect.ranges);
      for (const r of ranges) {
        expect(r.start, `${c.id}: range start in bounds`).toBeGreaterThanOrEqual(0);
        expect(r.end, `${c.id}: range end in bounds`).toBeLessThanOrEqual(c.text.length);
        expect(r.end, `${c.id}: range non-empty`).toBeGreaterThan(r.start);
      }
    });
  }
});

describe("tool-call text corpus: extractor (extractToolCallsFromText)", () => {
  for (const c of TOOL_CALL_TEXT_CORPUS) {
    const promoted = c.expect.promoted;
    if (promoted === undefined) continue;
    it(c.id, () => {
      const { toolCalls, remainingText } = extractToolCallsFromText(c.text, toolsFor(c));
      if (promoted === null) {
        expect(toolCalls, `${c.id}: nothing promoted`).toHaveLength(0);
        expect(remainingText, `${c.id}: unpromoted text left untouched`).toBe(c.text);
      } else {
        expect(toolCalls, `${c.id}: exactly one call promoted`).toHaveLength(1);
        expect(toolCalls[0].name, `${c.id}: promoted name`).toBe(promoted.name);
        expect(JSON.parse(toolCalls[0].arguments), `${c.id}: promoted args`).toEqual(promoted.args);
      }
      expectKeeps(remainingText, c.expect.remainingKeeps ?? [], `${c.id}: remainingText`);
    });
  }
});

describe("tool-call text corpus: persist hygiene (sanitizeModelOutput)", () => {
  for (const c of TOOL_CALL_TEXT_CORPUS) {
    it(c.id, () => {
      const out = sanitizeModelOutput(c.text, "persist");
      expectKeeps(out, c.expect.sanitizedKeeps, `${c.id}: sanitize`);
      expectDrops(out, c.expect.sanitizedDrops, `${c.id}: sanitize`);
      if (c.expect.ranges === 0 && c.expect.sanitizedDrops.length === 0) {
        expect(out, `${c.id}: clean text returns byte-identical`).toBe(c.text);
      }
    });
  }
});

describe("tool-call text corpus: post-hoc strip (stripToolCallBlocks)", () => {
  for (const c of TOOL_CALL_TEXT_CORPUS) {
    it(c.id, () => {
      const out = stripToolCallBlocks(c.text);
      expectDrops(out, c.expect.stripDrops, `${c.id}: strip`);
      // Prose the persist seam keeps must survive the UI strip too — same recognizer.
      expectKeeps(out, c.expect.sanitizedKeeps, `${c.id}: strip`);
      if (c.expect.ranges === 0 && c.expect.stripDrops.length === 0) {
        expect(out, `${c.id}: clean text survives (modulo trim)`).toBe(c.text.trim());
      }
    });
  }
});

describe("tool-call text corpus: history rebuild (sanitizeAssistantTextForRebuild)", () => {
  for (const c of TOOL_CALL_TEXT_CORPUS) {
    it(c.id, () => {
      const { cleaned, leaks } = sanitizeAssistantTextForRebuild(c.text);
      expect(leaks, `${c.id}: leak count`).toHaveLength(c.expect.rebuildLeaks);
      if (c.expect.rebuildLeaks === 0) {
        expect(cleaned, `${c.id}: no leak => byte-identical`).toBe(c.text);
        return;
      }
      if (c.expect.rebuildToolName !== undefined) {
        expect(leaks[0].toolName, `${c.id}: first leak toolName`).toBe(c.expect.rebuildToolName);
      }
      expect(cleaned, `${c.id}: corrective marker emitted`).toContain(WIRE_MARKER_PREFIX);
      if (c.expect.rebuildToolName) {
        expect(cleaned, `${c.id}: marker names the tool`).toContain(
          `${WIRE_MARKER_PREFIX} prior attempt to call ${c.expect.rebuildToolName} emitted as text`,
        );
      }
      expectKeeps(cleaned, c.expect.sanitizedKeeps, `${c.id}: rebuild`);
      expectDrops(cleaned, c.expect.sanitizedDrops, `${c.id}: rebuild`);
    });
  }
});

describe("tool-call text corpus: streaming latch (filterStreamDelta)", () => {
  for (const c of TOOL_CALL_TEXT_CORPUS) {
    if (c.expect.streamLatchesOnFirstLine === undefined) continue;
    it(c.id, () => {
      const firstLine = c.text.split("\n")[0];
      const out = filterStreamDelta(firstLine, false);
      if (c.expect.streamLatchesOnFirstLine) {
        expect(out, `${c.id}: first line latches`).toEqual({ suppress: true });
      } else {
        expect(out, `${c.id}: first line passes through`).toEqual({ text: firstLine });
      }
    });
  }
});
