/**
 * The irreversible floor, for TOOLS as well as shell text (2026-09-26).
 *
 * Under Power (the default profile) destructive means "allow", so app_delete, a
 * confirmed memory_forget and marketplace_install ran with no card while a
 * recoverable delete_file of an un-named file asked. The floor now keys on what
 * the act can be undone by, from tools/undo-pairs.ts: an irreversible tool gets
 * one confirm unless IRREVERSIBLE_TOOLS_UNCARDED says why not.
 */
import { describe, expect, it } from "vitest";
import { applyIrreversibleFloor } from "./approval-decision.js";
import { irreversibleToolReason, IRREVERSIBLE_TOOLS_UNCARDED } from "./irreversible-tools.js";
import { IRREVERSIBLE, RECOVERABLE_WITHOUT_PAIR } from "./tools/undo-pairs.js";

describe("irreversible tools get one confirm", () => {
  it("app_delete and marketplace_install: allow → ask, and allow-with-rollback → ask", () => {
    expect(applyIrreversibleFloor("allow", "app_delete", { name: "crm" })).toBe("ask");
    expect(applyIrreversibleFloor("allow-with-rollback", "marketplace_install", { name: "x" })).toBe("ask");
  });

  it("every irreversible tool is carded unless the exemption list says why — a new one is carded by default", () => {
    for (const tool of IRREVERSIBLE) {
      const carded = irreversibleToolReason(tool, { confirm: true }) !== null;
      expect(carded || tool in IRREVERSIBLE_TOOLS_UNCARDED, `${tool} is neither carded nor exempted with a reason`).toBe(true);
    }
    for (const tool of Object.keys(IRREVERSIBLE_TOOLS_UNCARDED)) {
      expect(IRREVERSIBLE.has(tool), `${tool} is exempted but not in IRREVERSIBLE`).toBe(true);
    }
  });

  it("recoverable tools stay uncarded: delete_file, forget (soft delete), email_delete (a Trash move)", () => {
    expect(applyIrreversibleFloor("allow", "delete_file", { path: "/tmp/x" })).toBe("allow");
    for (const tool of Object.keys(RECOVERABLE_WITHOUT_PAIR)) {
      expect(applyIrreversibleFloor("allow", tool, { query: "x" })).toBe("allow");
    }
  });

  it("a hard forget: the preview asks nothing, the confirmed delete asks — unless the user asked for it", () => {
    expect(applyIrreversibleFloor("allow", "memory_forget", { query: "acme" })).toBe("allow");
    expect(applyIrreversibleFloor("allow", "memory_forget", { query: "acme", confirm: true })).toBe("ask");
    expect(applyIrreversibleFloor("allow", "memory_forget", { query: "acme", confirm: true }, "Forget everything about Acme.")).toBe("allow");
    expect(applyIrreversibleFloor("allow", "memory_forget_imports", { source: "x", confirm: true }, "What do you know about Acme?")).toBe("ask");
  });

  it("never relaxes a deny or an existing ask", () => {
    expect(applyIrreversibleFloor("deny", "app_delete", {})).toBe("deny");
    expect(applyIrreversibleFloor("ask", "app_delete", {})).toBe("ask");
  });
});
