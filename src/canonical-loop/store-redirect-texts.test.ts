/**
 * appliedRedirectTexts — the durable record of mid-op amendments.
 *
 * The redirect column is one-slot and cleared on consume, and the [REDIRECT]
 * prompt row is transport-only, so the `redirect_applied` event body is the
 * ONLY place an applied instruction's text survives. spec-audit reads it back
 * to audit the done-claim against the amended request (2026-07-13: a worker
 * claimed a redirect it never implemented and the audit returned MET because
 * the instruction had vanished from every gate's view).
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// opDir captures the ops base at module load — override before importing.
const dataDir = mkdtempSync(join(tmpdir(), "lax-redirect-texts-"));
process.env.LAX_DATA_DIR = dataDir;

const store = await import("./store.js");

afterAll(() => {
  delete process.env.LAX_DATA_DIR;
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("appliedRedirectTexts", () => {
  it("returns applied instruction texts in application order", () => {
    const opId = "op_redirect_texts";
    store.appendCanonicalEvent(opId, "turn_started", { turnIdx: 0 });
    store.appendCanonicalEvent(opId, "redirect_applied", {
      turnIdx: 1, instructionId: "ri-1", text: "make sure its not dark theme",
    });
    store.appendCanonicalEvent(opId, "turn_committed", { turnIdx: 1 });
    store.appendCanonicalEvent(opId, "redirect_applied", {
      turnIdx: 3, instructionId: "ri-2", text: "give it a custom background",
    });

    expect(store.appliedRedirectTexts(opId)).toEqual([
      "make sure its not dark theme",
      "give it a custom background",
    ]);
  });

  it("skips pre-text events and blank texts; unknown op yields []", () => {
    const opId = "op_redirect_texts_legacy";
    // Events written before the text field existed carry only instructionId —
    // absent evidence, not an empty amendment.
    store.appendCanonicalEvent(opId, "redirect_applied", { turnIdx: 1, instructionId: "ri-old" });
    store.appendCanonicalEvent(opId, "redirect_applied", { turnIdx: 2, instructionId: "ri-blank", text: "   " });
    store.appendCanonicalEvent(opId, "redirect_applied", { turnIdx: 3, instructionId: "ri-3", text: "real one" });

    expect(store.appliedRedirectTexts(opId)).toEqual(["real one"]);
    expect(store.appliedRedirectTexts("op_never_existed")).toEqual([]);
  });
});
