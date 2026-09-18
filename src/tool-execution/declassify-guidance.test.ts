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
   * ('data-lineage' | 'tainted-shell') while a kernel taint quarantine reports
   * layer "arikernel" inside an "egress-aggregate". Correct words, unreachable
   * control, dead session. The policy layer now states clearability outright.
   */
  it("every blocker whose recovery names the button is marked clearable", () => {
    for (const rel of RECOVERY_SOURCES) {
      const lines = read(rel).split(/\r?\n/);
      lines.forEach((line, i) => {
        if (!line.includes("Declassify & retry")) return;
        // Prose about the mechanism (this flag's own doc comment) is not a blocker.
        if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
        // The blocker/result literal this recovery belongs to. Scanned as a
        // window because the text and the flag are not adjacent — and reaching
        // FORWARD because a shared recovery constant (DATA_LINEAGE_RECOVERY) is
        // declared above the blocker that carries it. A tripwire, not a proof:
        // it catches a new blocker added with no flag, which is how this broke.
        const block = lines.slice(Math.max(0, i - 14), i + 30).join(" ");
        expect(block, `${rel}:${i + 1} names the button but sets no clearable flag`)
          .toMatch(/clearable:\s*"declassify"/);
      });
    }
  });

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
