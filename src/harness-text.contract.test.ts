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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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
 * REACH — the half that catches the NEXT marker.
 *
 * This used to be a hand-typed list of six emitters and their literals, which
 * could only ever re-confirm markers someone had already thought of: a new
 * subsystem inventing a new marker was invisible to it, the same rot that put
 * the untrusted-content wrapper on a user's screen in the first place. So the
 * list is DERIVED — src/ is scanned for marker-shaped constants, and each one
 * must be registered or carry a written reason for not being.
 */

/** Escape a literal the way the registry does, so a fragment of a frame
 *  (a HEAD/TAIL pair) can be found inside a pattern's source. */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A marker-shaped constant: a module-level const whose value opens with `<<<`,
 * or with `[` followed by prose (a space). That is the shape every marker in
 * the registry is declared in. Requiring the space is what keeps the scan a
 * usable gate — without it, regex fragments like `const BAR = "[|｜]"` match.
 *
 * A literal split across concatenated lines yields only its first fragment.
 * That is enough: the registry's patterns close with an optional bracket, so a
 * prefix of a marker still matches the marker.
 */
const MARKER_CONST = /(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=\n]+)?=\s*\n?\s*"(\[[^"\n]*\s[^"\n]*|<<<[^"\n]*)"/g;

/**
 * Constants that LOOK like markers and deliberately are not. An entry here is
 * a claim that the text is not harness plumbing the model might echo back —
 * write the reason, because the default is that it belongs in the registry.
 */
const NOT_A_MARKER: Record<string, string> = {
  VOICE_INJECTION_NOTICE:
    "user-facing. It replaces the user's own transcription so they see why their speech was withheld — scrubbing it would hide a notice they are supposed to read.",
  EMPTY_USER_PLACEHOLDER:
    "wire filler, not an instruction. The Messages API rejects an empty text block, so a contentless user turn ships this instead. It is also short and generic enough that stripping it would eat a user's own words quoted back.",
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

/** Registered outright, or a distinctive fragment of a registered frame — the
 *  HEAD/TAIL of the turn-error boundary are each half of one marker. */
function isRegistered(literal: string): boolean {
  if (containsHarnessMarker(literal)) return true;
  const fragment = escapeRe(literal).slice(0, 32);
  return fragment.length === 32 && HARNESS_MARKERS.some((m) => m.pattern.source.includes(fragment));
}

describe("every marker-shaped constant in src/ is registered", () => {
  const found = sourceFiles(SRC).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return [...source.matchAll(MARKER_CONST)].map(([, name, literal]) => ({
      name,
      literal,
      file: relative(SRC, file).replace(/\\/g, "/"),
    }));
  });

  it("finds the constants at all, so a broken scan cannot pass vacuously", () => {
    expect(found.length, "the marker scan matched nothing — MARKER_CONST has stopped matching").toBeGreaterThan(3);
  });

  for (const c of found) {
    it(`${c.file} → ${c.name}`, () => {
      if (NOT_A_MARKER[c.name]) return;
      expect(
        isRegistered(c.literal),
        `${c.name} in ${c.file} writes harness text into the model and no HARNESS_MARKERS entry strips a model's echo of it. ` +
          `Add it to the registry, or add it to NOT_A_MARKER with the reason it is not plumbing.`,
      ).toBe(true);
    });
  }
});

describe("the registry points at real code", () => {
  it("every entry names an emitter file that exists, so the next maintainer can find it", () => {
    for (const marker of HARNESS_MARKERS) {
      expect(marker.sample, `${marker.id} has no sample`).toBeTruthy();
      expect(containsHarnessMarker(marker.sample), `${marker.id}'s own sample does not match its pattern`).toBe(true);
      const file = marker.emitter.split(/\s+/).find((t) => t.endsWith(".ts"));
      expect(file, `${marker.id}'s emitter "${marker.emitter}" names no .ts file`).toBeTruthy();
      expect(
        existsSync(join(SRC, file!)),
        `${marker.id} names emitter ${file} — that file no longer exists`,
      ).toBe(true);
    }
  });
});
