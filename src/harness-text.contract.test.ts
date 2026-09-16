/**
 * CLASS INVARIANT: harness text goes INTO the model and never comes back out.
 *
 * The instance (2026-09-16): a model quoted its tool results back and the
 * untrusted-content wrapper streamed into the user's chat, then vanished when
 * the turn committed. The stream scrubber knew about provider special tokens
 * and had never been taught about that wrapper — and would not have been taught
 * about the situational digest, the automatic-check nudge, the inject frame or
 * the repeated-call header either, each written by a different subsystem.
 *
 * So the test is not "the wrapper is stripped". It is: EVERY marker in the
 * registry is stripped by EVERY scrubber that guards assistant text, and every
 * marker literal an emitter writes is IN the registry. A new marker that no
 * scrubber handles fails here instead of on a user's screen.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESS_MARKERS, containsHarnessMarker, stripHarnessMarkers } from "./harness-text.js";
import { sanitizeModelOutput, stripLeakedSpecialTokensStreaming } from "./providers/output-sanitize.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)));

/** Every boundary that renders or stores what the MODEL said. */
const ASSISTANT_TEXT_SCRUBBERS: Array<{ name: string; scrub: (t: string) => string }> = [
  { name: "persist (sanitizeModelOutput)", scrub: (t) => sanitizeModelOutput(t, "persist") },
  { name: "delivery (sanitizeModelOutput)", scrub: (t) => sanitizeModelOutput(t, "delivery") },
  { name: "live stream (stripLeakedSpecialTokensStreaming)", scrub: stripLeakedSpecialTokensStreaming },
  { name: "registry helper (stripHarnessMarkers)", scrub: stripHarnessMarkers },
];

describe("every harness marker is stripped at every assistant-text boundary", () => {
  for (const marker of HARNESS_MARKERS) {
    for (const boundary of ASSISTANT_TEXT_SCRUBBERS) {
      it(`${marker.id} → ${boundary.name}`, () => {
        const echoed = `Here is what I found.\n${marker.sample}\nSo the answer is 1,200 per minute.`;
        const out = boundary.scrub(echoed);
        expect(containsHarnessMarker(out), `${marker.id} survived ${boundary.name}`).toBe(false);
        // The model's own words are not collateral.
        expect(out).toContain("Here is what I found.");
        expect(out).toContain("So the answer is 1,200 per minute.");
      });
    }
  }

  it("leaves ordinary prose and code punctuation alone", () => {
    for (const text of [
      "Use <div> for layout and a <<< fence in the doc.",
      "The checklist is [DONE] and the note said [see below].",
      "Array access like arr[0] and a shell heredoc <<EOF stay put.",
    ]) {
      for (const boundary of ASSISTANT_TEXT_SCRUBBERS) {
        expect(boundary.scrub(text), `${boundary.name} mangled ordinary prose`).toBe(text);
      }
    }
  });
});

/**
 * REACH — the half that catches the NEXT marker. Each emitter names the literal
 * it writes; this reads those files and asserts the registry recognizes what
 * they emit. A subsystem that invents a new bracketed marker and forgets the
 * registry fails here, which is exactly how the wrapper slipped through.
 */
describe("every emitted marker literal is registered", () => {
  const EMITTERS: Array<{ file: string; literals: string[] }> = [
    { file: "sanitize.ts", literals: ["<<<EXTERNAL_UNTRUSTED_CONTENT", "<<<END_EXTERNAL_UNTRUSTED_CONTENT"] },
    { file: "context/system-prompt-builder.ts", literals: ["[HARNESS NOTE:", "[END HARNESS NOTE]"] },
    { file: "canonical-loop/turn-loop/situational-awareness.ts", literals: ["[SITUATIONAL CONTEXT", "[END CONTEXT]"] },
    { file: "canonical-loop/turn-loop/tool-failure-summary.ts", literals: ["[automatic check]"] },
    { file: "canonical-loop/turn-loop/inject-drain.ts", literals: ["[mid-turn user message]"] },
    { file: "tool-execution/resolve-tool.ts", literals: ["[REPEATED CALL"] },
  ];

  for (const emitter of EMITTERS) {
    it(`${emitter.file} still writes markers this registry owns`, () => {
      const source = readFileSync(join(SRC, emitter.file), "utf8");
      for (const literal of emitter.literals) {
        expect(source.includes(literal), `${emitter.file} no longer emits ${literal} — update HARNESS_MARKERS`).toBe(true);
      }
      // The registry names this file as an owner, so a marker cannot be
      // emitted by a subsystem the registry has never heard of.
      const owned = HARNESS_MARKERS.some((m) => emitter.file.endsWith(m.emitter.split(" ")[0]) || m.emitter.startsWith(emitter.file));
      expect(owned, `no HARNESS_MARKERS entry names ${emitter.file} as its emitter`).toBe(true);
    });
  }

  it("names an emitter for every registry entry, so the next maintainer can find it", () => {
    for (const marker of HARNESS_MARKERS) {
      expect(marker.emitter, `${marker.id} has no emitter`).toBeTruthy();
      expect(marker.sample, `${marker.id} has no sample`).toBeTruthy();
      expect(containsHarnessMarker(marker.sample), `${marker.id}'s own sample does not match its pattern`).toBe(true);
    }
  });
});
