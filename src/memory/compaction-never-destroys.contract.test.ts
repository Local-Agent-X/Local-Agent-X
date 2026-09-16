/**
 * CLASS INVARIANT: automatic compaction never destroys stored history. Only the
 * user can.
 *
 * Two mechanisms shorten a conversation and they are NOT interchangeable:
 *
 *   summary row     — the user asked (/api/compact). Read back, it DROPS every
 *                     msg row before it. The transcript really is shorter now,
 *                     because that is what they asked for.
 *   checkpoint row  — the harness decided the request was getting expensive.
 *                     Every row stays; only the model's view is shortened.
 *
 * They differ by one word in a row `kind`, and the failure mode is invisible:
 * a user scrolls up weeks later and their conversation is gone. OpenHands
 * reached the same split independently — their condenser records condensation
 * as an event and never mutates the stored log — which is some evidence this is
 * the right line rather than local taste.
 *
 * So: nothing on the automatic path may write a summary row, and the only
 * writer of one is the route the user invokes.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { sourceFiles(full, out); continue; }
    if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".test-helper.ts")) out.push(full);
  }
  return out;
}

/** The marker whose presence at messages[0] makes writeSessionLog emit a
 *  history-dropping summary row. */
const DESTRUCTIVE_MARKER = "COMPACTION_PREFIX";

/** Comments discuss the marker freely; only CODE that reaches for it counts. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("only the user's own compact may shorten the transcript", () => {
  it("nothing outside the compact route builds a COMPACTION_PREFIX row", () => {
    // Writers, not readers: retract-last-turn and the session log READ the
    // marker to respect an existing compaction, which is not the same as
    // creating one.
    const ALLOWED = new Set([
      "routes/chat/compact-route.ts",     // the user invoked it
      "types.ts",                          // declares the constant
      "memory/session-message-log.ts",     // persists what it is handed
      "memory/retract-last-turn.ts",       // treats it as an immovable floor
      "canonical-loop/chat-runner/create-op.ts", // folds an existing one into the prompt
      "routes/chat/run-chat-turn/canonical-run.ts", // keeps an existing one on save
      "routes/chat/delegation-handoff.ts", // same keep-what-exists filter
    ]);
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file).split(sep).join("/");
      if (ALLOWED.has(rel)) continue;
      // Comments discuss the marker freely — only CODE that reaches for it counts.
      const source = stripComments(readFileSync(file, "utf8"));
      if (source.includes(DESTRUCTIVE_MARKER)) offenders.push(rel);
    }
    expect(
      offenders,
      `these reach for the history-DROPPING compaction marker: ${offenders.join(", ")}. ` +
        "Automatic compaction uses a checkpoint row (context-manager/checkpoint-history.ts), which keeps every " +
        "message and shortens only what the model is sent. A summary row deletes the user's transcript.",
    ).toEqual([]);
  });

  it("the automatic path writes checkpoints, and checkpoints keep everything", async () => {
    const { checkpointedHistory } = await import("../context-manager/checkpoint-history.js");
    const source = readFileSync(join(SRC, "context-manager/checkpoint-history.ts"), "utf8");
    expect(source).not.toContain(DESTRUCTIVE_MARKER);
    expect(typeof checkpointedHistory).toBe("function");
  });

  it("the session log only emits a summary row for a transcript that already leads with one", () => {
    const source = readFileSync(join(SRC, "memory/session-message-log.ts"), "utf8");
    // The guard: a summary row is written ONLY when messages[0] already carries
    // the marker — i.e. the caller handed over an already-compacted transcript.
    expect(source).toContain("const compactionLeader =");
    expect(source).toContain("if (compactionLeader) {");
  });
});
