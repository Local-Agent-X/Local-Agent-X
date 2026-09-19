import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Live failure 2026-09-08: a session was quarantined by a sensitive read, and
// the agent relayed our own recovery text — "hit declassify in Settings →
// Security". No such control exists there. The only declassify control is the
// "Declassify & retry" button rendered on the blocked tool card itself
// (public/js/chat-declassify-action.js, gated on a data-lineage / tainted-shell
// layer in chat-render-artifacts.js). Recovery text a model repeats verbatim
// has to name a control the user can actually find.
const root = join(import.meta.dirname, "..", "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf-8");

const RECOVERY_SOURCES = [
  "src/tool-execution/egress-gates.ts",
  "src/tool-execution/enforce-policy.ts",
];

describe("taint recovery guidance", () => {
  it("never sends the user to Settings for declassify", () => {
    for (const rel of [...RECOVERY_SOURCES, "public/js/chat-declassify-action.js"]) {
      const text = read(rel);
      for (const line of text.split("\n")) {
        if (!/declassif/i.test(line)) continue;
        expect(line, `${rel} points at Settings for declassify`).not.toMatch(/Settings\s*(→|->|>)\s*Security/);
      }
    }
  });

  it("names the button that actually exists", () => {
    for (const rel of RECOVERY_SOURCES) {
      expect(read(rel)).toContain("Declassify & retry");
    }
  });

  it("keeps the button label in the recovery text and the UI identical", () => {
    const ui = read("public/js/chat-declassify-action.js");
    const label = /btn\.textContent\s*=\s*'(?:🔓\s*)?([^']+)'/.exec(ui)?.[1];
    expect(label).toBe("Declassify & retry");
    for (const rel of RECOVERY_SOURCES) expect(read(rel)).toContain(label as string);
  });

  /**
   * The gap this suite did NOT close, found live 2026-09-18: every string was
   * correct — the model dutifully told the user to click "Declassify & retry" —
   * and the card could not render, because the UI decided from LAYER NAMES
   * while a kernel taint quarantine reports layer "arikernel" inside an
   * "egress-aggregate". Correct words, unreachable control, dead session.
   *
   * Whether a real blocker carries the flag is asserted against the real
   * objects, not this file's text: browser-write-taint-scope.test.ts (the
   * data-lineage blocker) and sc10-egress-aggregate.test.ts (the kernel one).
   * A source-layout scan lived here briefly and broke on an unrelated edit —
   * it measured where the lines sat, not what the gate returns.
   */
  it("the UI decides off the flag, not only off layer names", () => {
    // The rule lives with the card it gates; the renderer must defer to it
    // rather than keep a second copy of the layer list. Behaviour (which
    // payloads actually render a button) is proven against the real predicate
    // and real DOM in test/declassify-card-render.test.ts — this only pins that
    // the seam stays wired, since source text alone cannot show a card.
    expect(read("public/js/chat-declassify-action.js")).toMatch(/clearable\s*===\s*'declassify'/);
    expect(read("public/js/chat-render-artifacts.js")).toMatch(/isDeclassifiable\(/);
  });

  it("still tells the model the block is clearable, not terminal", () => {
    // The egress message used to say "end the session", which reads as no
    // recovery at all — the button was right there on the same card.
    const egress = read("src/tool-execution/egress-gates.ts");
    const line = egress.split("\n").find((l) => l.includes("Declassify & retry")) ?? "";
    expect(line).not.toMatch(/end the session/);
  });
});
