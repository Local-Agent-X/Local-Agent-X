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

  it("still tells the model the block is clearable, not terminal", () => {
    // The egress message used to say "end the session", which reads as no
    // recovery at all — the button was right there on the same card.
    const egress = read("src/tool-execution/egress-gates.ts");
    const line = egress.split("\n").find((l) => l.includes("Declassify & retry")) ?? "";
    expect(line).not.toMatch(/end the session/);
  });
});
