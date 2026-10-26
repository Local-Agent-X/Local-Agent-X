/**
 * The irreversible floor, for TOOLS as well as shell text (2026-09-26).
 *
 * Under Power (the default profile) destructive means "allow", so app_delete, a
 * confirmed memory_forget and marketplace_install ran with no card while a
 * recoverable delete_file of an un-named file asked. The floor now keys on what
 * the act can be undone by, from each row's `undo`: an irreversible tool gets
 * one confirm unless its row says why not (`uncarded`).
 */
import { describe, expect, it } from "vitest";
import { applyIrreversibleFloor } from "./approval-decision.js";
import { irreversibleToolReason } from "./irreversible-tools.js";
import { policyRowOf } from "./tool-registry.js";
import { IRREVERSIBLE, RECOVERABLE_WITHOUT_PAIR } from "./tools/undo-pairs.js";

describe("irreversible tools get one confirm", () => {
  // Both are recoverable now, so neither is carded as if it destroyed
  // something (2026-10-26): app_delete recycles the app's stored state as well
  // as its files, and marketplace_install keeps the protocol it replaces.
  it("app_delete and marketplace_install: recoverable, so the floor leaves them to the profile", () => {
    expect(applyIrreversibleFloor("allow", "app_delete", { id: "crm" })).toBe("allow");
    expect(applyIrreversibleFloor("allow-with-rollback", "marketplace_install", { name: "x" })).toBe("allow-with-rollback");
    expect(RECOVERABLE_WITHOUT_PAIR.app_delete).toMatch(/recycle bin/);
    expect(RECOVERABLE_WITHOUT_PAIR.marketplace_install).toMatch(/recycle bin/);
  });

  it("every irreversible tool is carded unless its row says why not — a new one is carded by default", () => {
    const uncarded: string[] = [];
    for (const tool of IRREVERSIBLE) {
      const undo = policyRowOf(tool)?.undo;
      const why = undo && "irreversible" in undo ? undo.uncarded : undefined;
      expect(irreversibleToolReason(tool, { confirm: true }) !== null, tool).toBe(why === undefined);
      if (why) uncarded.push(tool);
    }
    expect(uncarded.sort()).toEqual(["agent_cancel", "apply_update", "op_kill", "self_edit"]);
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
    for (const said of ["Drop what you have on Acme.", "Get rid of the Acme notes.", "Scrap that, it's outdated.", "Discard the Acme fact.", "Stop remembering my old address."]) {
      expect(applyIrreversibleFloor("allow", "memory_forget", { query: "acme", confirm: true }, said), said).toBe("allow");
    }
    // A complaint is not a request to forget: "you made that up" is the phrase
    // a 27B took as one and forgot a TRUE fact (fact-confirmation.ts).
    expect(applyIrreversibleFloor("allow", "memory_forget", { query: "acme", confirm: true }, "That's wrong, you made that up.")).toBe("ask");
    expect(applyIrreversibleFloor("allow", "memory_forget_imports", { source: "x", confirm: true }, "What do you know about Acme?")).toBe("ask");
  });

  it("never relaxes a deny or an existing ask", () => {
    expect(applyIrreversibleFloor("deny", "memory_forget", { confirm: true })).toBe("deny");
    expect(applyIrreversibleFloor("ask", "app_delete", {})).toBe("ask");
  });
});
