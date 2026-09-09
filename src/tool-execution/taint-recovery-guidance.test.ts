import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_LINEAGE_RECOVERY } from "./egress-gates.js";

// CLASS LOCK for taint-recovery guidance.
//
// A blocked outbound call tells the model how the user can undo the block. For
// a while it told them to open Settings and, failing that, to end the session —
// neither of which is the control. The only declassify affordance is the
// "Declassify & retry" button on the blocked card in the chat, so guidance that
// names anything else strands the user with no way forward.
//
// Two separate sites emit this guidance (the data-lineage egress blocker and
// the tainted-shell policy terminate), each with its own sentence. Sharing one
// string across both would flatten two different contexts, so instead both are
// held to the same two rules: name the button, never route to Settings. A third
// site added later is covered the moment it lands in one of these files.

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));

const SITES = ["egress-gates.ts", "enforce-policy.ts"];

/** The recovery guidance strings a source file emits, one per `recovery:` key. */
function recoveryStrings(file: string): string[] {
  const src = readFileSync(resolve(HERE, file), "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/recovery:\s*"((?:[^"\\]|\\.)*)"/g)) out.push(m[1]);
  return out;
}

/**
 * Guidance about the declassify control, as opposed to unrelated recovery text.
 * egress-gates.ts holds its sentence in an exported constant rather than inline
 * at the `recovery:` key, so add that too — a rule the scan can't see is a rule
 * that isn't enforced.
 */
function declassifyGuidance(file: string): string[] {
  const inline = recoveryStrings(file);
  const named = file === "egress-gates.ts" ? [DATA_LINEAGE_RECOVERY] : [];
  return [...inline, ...named].filter(s => /declassif/i.test(s));
}

describe("taint-recovery guidance points at the control that exists", () => {
  it("every site that mentions declassifying names the blocked-card button", () => {
    for (const file of SITES) {
      const strings = declassifyGuidance(file);
      expect(strings.length, `${file} emits no declassify guidance — has the site moved?`).toBeGreaterThan(0);
      for (const s of strings) {
        expect(s, `${file}: "${s.slice(0, 60)}..."`).toMatch(/Declassify & retry/);
        expect(s, `${file}: names the blocked card as where the button lives`).toMatch(/blocked card/i);
      }
    }
  });

  it("no site sends the user to Settings for it", () => {
    for (const file of SITES) {
      for (const s of declassifyGuidance(file)) {
        // Saying "it is NOT in Settings" / "do not send them to Settings" is the
        // correction itself and must stay legal; what is banned is directing
        // them there. So every mention has to sit in a negated sentence.
        for (const sentence of s.split(/(?<=[.!?])\s+/)) {
          if (!/\bSettings\b/i.test(sentence)) continue;
          expect(sentence, `${file} mentions Settings without negating it`).toMatch(/\b(not|never|n't)\b/i);
        }
      }
    }
  });

  it("no site tells the user to end the session instead", () => {
    for (const file of SITES) {
      for (const s of declassifyGuidance(file)) {
        expect(s, `${file} still offers ending the session as the recovery`).not.toMatch(/end the session/i);
      }
    }
  });

  it("the exported constant is the string the blocker actually carries", () => {
    expect(recoveryStrings("egress-gates.ts")).not.toContain(DATA_LINEAGE_RECOVERY);
    expect(DATA_LINEAGE_RECOVERY).toMatch(/Declassify & retry/);
  });
});
