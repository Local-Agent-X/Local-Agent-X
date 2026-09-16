/**
 * CLASS INVARIANT: nothing overrides the user's autonomy profile without saying
 * why, in one place.
 *
 * The instance (2026-09-16): the browser's sensitive-page gate asked for
 * approval on every high-risk action with `alwaysAsk: true`, regardless of the
 * profile. With prompts turned off, the user still got a card per cloud-console
 * click and no setting could stop it. Three OTHER sites carry the same flag
 * legitimately — a security setting, plan mode, a download quarantine — and
 * nothing told them apart, so the bug was invisible next to its valid cousins.
 *
 * This scans the source rather than trusting a list: an override added tomorrow
 * fails here until someone writes down what it protects and why the profile
 * does not govern it.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ALWAYS_ASK_SITES } from "./approval-overrides.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { sourceFiles(full, out); continue; }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts") || entry.endsWith(".test-helper.ts")) continue;
    out.push(full);
  }
  return out;
}

/** Files that pass `alwaysAsk: true` to the approval manager. */
function filesWithAlwaysAsk(): string[] {
  const hits: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, "utf8");
    // The manager declares the parameter and this registry quotes the literal
    // in prose — neither is a call site.
    if (file.endsWith(`${sep}approval-manager.ts`)) continue;
    if (file.endsWith(`${sep}approval-overrides.ts`)) continue;
    if (/alwaysAsk:\s*true/.test(source)) hits.push(relative(SRC, file).split(sep).join("/"));
  }
  return hits.sort();
}

describe("profile overrides are declared", () => {
  it("every alwaysAsk site is registered with what it protects and why", () => {
    const registered = new Set(ALWAYS_ASK_SITES.map((s) => s.file));
    const undeclared = filesWithAlwaysAsk().filter((f) => !registered.has(f));
    expect(
      undeclared,
      `these bypass the user's autonomy profile with no entry in approval-overrides.ts: ${undeclared.join(", ")}. ` +
        "An override is legitimate only when it protects the USER'S OWN MANDATE (a setting they own, an instruction " +
        "they gave, a quarantine they asked for) — not because an action feels risky, which the profile already decides.",
    ).toEqual([]);
  });

  it("every registered site still carries the flag — no stale entries", () => {
    const actual = new Set(filesWithAlwaysAsk());
    const stale = ALWAYS_ASK_SITES.filter((s) => !actual.has(s.file)).map((s) => s.file);
    expect(stale, `registered but no longer overriding: ${stale.join(", ")}`).toEqual([]);
  });

  it("each entry says what it protects AND why the profile does not waive it", () => {
    for (const site of ALWAYS_ASK_SITES) {
      expect(site.what.length, `${site.file}: empty "what"`).toBeGreaterThan(10);
      expect(site.why.length, `${site.file}: "why" must be a real argument`).toBeGreaterThan(60);
    }
  });

  it("the sensitive-page ACTION gate reads the profile instead of overriding it", () => {
    // The fix that motivated this file. If someone re-adds an unconditional ask
    // there, the first test above will also fire — this one names it.
    const gates = readFileSync(join(SRC, "tools/browser-tools/gates.ts"), "utf8");
    expect(gates).toContain("getRiskDecision");
    const sensitiveBlock = gates.slice(gates.indexOf('disposition === "approval-required"'));
    expect(sensitiveBlock.slice(0, sensitiveBlock.indexOf("requestApprovalDetailed"))).toContain("decisionRequiresPrompt");
  });
});
