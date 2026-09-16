/**
 * CLASS INVARIANT: every failure the model reads says what to do next.
 *
 * The instance (2026-09-16): a browser click came back as
 * `{"error":"side-effect journal claim lost"}`. True, internal, and useless —
 * the model cannot act on a sentence about a journal claim, so it retried the
 * identical click ten times. Tools already answer both questions (what broke,
 * what now) through the result envelope's recovery line; the harness's OWN
 * failures skipped the envelope entirely and shipped a raw exception string.
 *
 * So: no dispatcher may mint a bare `{ error }`, and an internal failure must
 * render with a Recovery line. The source scan is the half that catches the
 * next one — a new dispatcher path that reaches for the old shape fails here.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { internalToolFailureText } from "./internal-tool-failure.js";

const LOOP = resolve(dirname(fileURLToPath(import.meta.url)));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { sourceFiles(full, out); continue; }
    if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".test-helper.ts")) out.push(full);
  }
  return out;
}

describe("an internal failure is actionable", () => {
  it("renders as a normal error envelope with a Recovery line", () => {
    const text = internalToolFailureText("browser failed inside the harness: side-effect journal claim lost");
    expect(text).toContain("[error");
    expect(text).toContain("side-effect journal claim lost");
    expect(text).toContain("Recovery:");
    // The default recovery has to steer AWAY from the identical retry that the
    // live incident produced ten of.
    expect(text.toLowerCase()).toContain("retrying the identical call");
  });

  it("carries a caller's specific recovery when there is one", () => {
    const text = internalToolFailureText(
      "The harness lost the result of 'browser'.",
      "Treat the outcome as UNKNOWN: check the state before repeating it.",
    );
    expect(text).toContain("Recovery: Treat the outcome as UNKNOWN");
  });

  it("marks it as harness-side, not the model's bad arguments", () => {
    expect(internalToolFailureText("x")).toMatch(/internal|harness/i);
  });
});

describe("no dispatcher mints a bare { error } any more", () => {
  it("canonical-loop routes internal failures through the envelope", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(LOOP)) {
      if (file.endsWith(`${sep}internal-tool-failure.ts`)) continue;
      const source = readFileSync(file, "utf8");
      // `result: { error: … }` — the shape that reached the model as raw JSON.
      if (/result:\s*\{\s*error:/.test(source)) offenders.push(relative(LOOP, file).split(sep).join("/"));
    }
    expect(
      offenders,
      `these mint a bare { error } the model cannot act on: ${offenders.join(", ")}. ` +
        "Use internalToolFailureText(what, recovery) so it arrives with a Recovery line, like every tool failure.",
    ).toEqual([]);
  });
});
