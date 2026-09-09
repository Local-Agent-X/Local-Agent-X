/**
 * Contract: EVERY middleware nudge reason is EXPLICITLY classified — either
 * retractable (RETRACTABLE_REASONS, retract-false-claim.ts) or explicitly
 * non-retractable (the ledger below). Silent omission is not a classification.
 *
 * Why this exists. A middleware's `{ kind: "nudge", reason }` string is the
 * whole wire contract for the CONSEQUENCE: decide-outcome.ts keys retraction
 * (and replace-status) off that string, and a reason no consequence list
 * mentions gets "nudge only" by default — invisibly. On 2026-07-10 commit
 * 7d524491 deleted the hallucination-check middleware; its two reasons
 * ("worker-hallucination", "creation-hallucination") stayed behind in
 * RETRACTABLE_REASONS as dead literals for two months, and the guard that
 * INHERITED the responsibility — action-claim — landed emitting a reason that
 * appeared in NO consequence list, so its consequence was lost in the fold with
 * nothing going red. Both halves of that failure are asserted away here:
 *
 *   - every reason a middleware can emit must be classified (a new guard with
 *     an undeclared consequence fails the build, by file:line), and
 *   - every classified reason must actually be emitted (a reason whose emitter
 *     was deleted fails the build instead of lingering).
 *
 * The middleware directory is the only producer of `middlewareDirective.reason`
 * — host.ts returns the firing middleware's result verbatim, turn-loop.ts only
 * forwards it, and the completion gates (decide-outcome-gates.ts) append nudges
 * as user messages without a reason — so scanning that directory is exhaustive.
 *
 * Scope is the NUDGE directive. `abort` / `suspend` reasons drive the worker's
 * suspend/abort paths (worker.ts), not retraction, and are a separate contract.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLEANUP_VERIFY_REASON,
  CLEANUP_VERIFY_FALSE_DONE_REASON,
  CODEBASE_ADVICE_GROUNDING_REASON,
  OPERATIONAL_CLAIM_REASON,
  SOURCE_VERIFY_REASON,
} from "../../agent-guards/index.js";
import { ACTION_CLAIM_REASON } from "../middlewares/action-claim.js";
import { ATTRIBUTION_CONFABULATION_REASON } from "../middlewares/attribution-claim.js";
import { BROWSER_HANDOFF_REASON } from "../middlewares/browser-handoff.js";
import { TOOL_SEARCH_RECOVERY_REASON } from "../middlewares/tool-search-nudge.js";
import {
  INSTRUCTION_OBLIGATION_REASON,
  INSTRUCTION_VIOLATION_REASON,
} from "../middlewares/instruction-audit.js";
import { RETRACTABLE_REASONS, isRetractableHallucination } from "./retract-false-claim.js";

const MIDDLEWARE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../middlewares");

/** post-turn-detector emits one reason per detector kind (`post-turn:${kind}`).
 *  The scanner reduces that template to its static prefix and the FAMILY is
 *  classified as a whole — no member of it retracts. */
const POST_TURN_FAMILY = "post-turn:";

/**
 * Reasons whose consequence is deliberately NOT retraction: the nudge fires,
 * the model gets the correction, and the assistant text it already streamed
 * STANDS. This is the "explicitly declared" half — a reason lands here only
 * because someone decided it should not retract, not because it was forgotten.
 */
const NON_RETRACTABLE_REASONS: ReadonlySet<string> = new Set<string>([
  // DECIDED (Peter, 2026-09-08): action-claim stays nudge-only. It is the guard
  // that inherited hallucination-check's job in 7d524491 and has never had a
  // retract consequence wired; making it retract now would be a behavior change,
  // not a refactor. It is declared here so the omission is a decision on the
  // record instead of a hole.
  ACTION_CLAIM_REASON,
  // Grounding-table reasons that are not "retract". codebase-advice-grounding
  // carries the SEPARATE replace-status consequence (its text is swapped for a
  // status line in decide-outcome.ts, not dropped); the rest nudge / partial-
  // label. claim-grounding-dispatch.test.ts pins each against rule.consequence.
  CODEBASE_ADVICE_GROUNDING_REASON,
  CLEANUP_VERIFY_REASON,
  SOURCE_VERIFY_REASON,
  "verify-gate-test-deletion",
  // Instruction-ledger audit: the answer is kept and the model is told to
  // honour the instruction it missed.
  INSTRUCTION_OBLIGATION_REASON,
  INSTRUCTION_VIOLATION_REASON,
  // Continuation / anti-stall nudges. Nothing they fire on is a false claim —
  // the turn is unfinished, repetitive, or too narrow — so the text stands and
  // the next turn adds to it.
  "app-design-guard",
  "assertion-repeat",
  "broad-sweep-enumerate",
  "budget-ladder",
  "budget-ladder-dry",
  "dead-end",
  "external-change-diff",
  "false-refusal-grounding",
  "interactive-build-seed",
  "loop-detection",
  "no-progress-spin",
  "open-steps",
  "open-steps-seed",
  "post-edit-diagnostics",
  POST_TURN_FAMILY,
  "premature-completion",
  "refute-completion",
  "repeat-failure",
  "repeat-output",
  "self-check",
  "strategy-pivot",
  "thrash-guard",
]);

/**
 * Named reason constants the scanner may meet in a `reason:` position, keyed by
 * the identifier as it is written in the middleware. Imported from the modules
 * that own them, so a value rename cannot desync this ledger from the emitter.
 * An identifier missing from here fails the scan: add the import.
 */
const REASON_CONSTANTS: Readonly<Record<string, string>> = {
  ACTION_CLAIM_REASON,
  ATTRIBUTION_CONFABULATION_REASON,
  BROWSER_HANDOFF_REASON,
  TOOL_SEARCH_RECOVERY_REASON,
  CODEBASE_ADVICE_GROUNDING_REASON,
  CLEANUP_VERIFY_REASON,
  CLEANUP_VERIFY_FALSE_DONE_REASON,
  OPERATIONAL_CLAIM_REASON,
  SOURCE_VERIFY_REASON,
  INSTRUCTION_OBLIGATION_REASON,
  INSTRUCTION_VIOLATION_REASON,
};

/**
 * Emitters that pick their reason at runtime, so no value can be read off the
 * `reason:` position. Each declares every reason it can emit; those values are
 * classified like any other. A new dynamic emitter without an entry fails the
 * scan rather than slipping through unclassified.
 */
const DYNAMIC_EMITTERS: Readonly<Record<string, readonly string[]>> = {
  // cleanup-verify.ts picks between the honest "still remain" wrap-up reason and
  // the retract-grade false-done escalation just before it returns.
  "cleanup-verify.ts": [CLEANUP_VERIFY_REASON, CLEANUP_VERIFY_FALSE_DONE_REASON],
};

const isSource = (name: string) =>
  name.endsWith(".ts") &&
  !name.endsWith(".test.ts") &&
  !name.endsWith(".test-helper.ts") &&
  !name.endsWith(".d.ts") &&
  // The directive TYPE lives here (`reason: string`), no directive is emitted.
  name !== "types.ts";

/** Line-preserving comment strip, so prose quoting a directive is not scanned
 *  and reported line numbers stay real. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

/** The object literal enclosing `at` — the directive being returned. */
function objectAround(src: string, at: number): string | null {
  let depth = 0;
  let start = -1;
  for (let i = at; i >= 0; i--) {
    const c = src[i];
    if (c === "}") depth++;
    else if (c === "{") {
      if (depth === 0) { start = i; break; }
      depth--;
    }
  }
  if (start < 0) return null;
  depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

type ReasonRef =
  | { kind: "value"; value: string }
  | { kind: "identifier"; name: string }
  | { kind: "runtime" };

/** Read the directive's `reason` as a literal value, a named constant, or a
 *  runtime-chosen value. A template with an interpolation collapses to its
 *  static prefix — the reason FAMILY. */
function readReason(objectText: string): ReasonRef {
  const key = /\breason\s*:\s*/.exec(objectText);
  if (!key) return { kind: "runtime" }; // `{ …, reason }` shorthand off a variable
  const rest = objectText.slice(key.index + key[0].length);
  const quote = rest[0];
  if (quote === '"' || quote === "'") {
    const end = rest.indexOf(quote, 1);
    return end < 0 ? { kind: "runtime" } : { kind: "value", value: rest.slice(1, end) };
  }
  if (quote === "`") {
    const end = rest.indexOf("`", 1);
    if (end < 0) return { kind: "runtime" };
    const raw = rest.slice(1, end);
    const interp = raw.indexOf("${");
    return { kind: "value", value: interp < 0 ? raw : raw.slice(0, interp) };
  }
  const id = /^[A-Za-z_$][\w$]*/.exec(rest);
  return id ? { kind: "identifier", name: id[0] } : { kind: "runtime" };
}

interface Emitted { file: string; line: number; value: string }

const sources = readdirSync(MIDDLEWARE_DIR).filter(isSource).sort();
const emitted: Emitted[] = [];
const unreadable: string[] = [];

for (const file of sources) {
  const src = stripComments(readFileSync(join(MIDDLEWARE_DIR, file), "utf8"));
  for (let at = src.indexOf('kind: "nudge"'); at >= 0; at = src.indexOf('kind: "nudge"', at + 1)) {
    const line = src.slice(0, at).split("\n").length;
    const object = objectAround(src, at);
    const ref: ReasonRef = object ? readReason(object) : { kind: "runtime" };
    if (ref.kind === "value") {
      emitted.push({ file, line, value: ref.value });
    } else if (ref.kind === "identifier") {
      const value = REASON_CONSTANTS[ref.name];
      if (value === undefined) unreadable.push(`${file}:${line} unknown constant ${ref.name}`);
      else emitted.push({ file, line, value });
    } else {
      const declared = DYNAMIC_EMITTERS[file];
      if (!declared) unreadable.push(`${file}:${line} runtime-chosen reason`);
      else for (const value of declared) emitted.push({ file, line, value });
    }
  }
}

const emittedValues = new Set(emitted.map((e) => e.value));
const classified = new Set([...RETRACTABLE_REASONS, ...NON_RETRACTABLE_REASONS]);

describe("middleware nudge-reason coverage", () => {
  it("sees the guards it is classifying (no vacuous pass)", () => {
    expect(sources).toContain("action-claim.ts");
    expect(sources).toContain("tool-search-nudge.ts");
    expect(sources).toContain("browser-handoff.ts");
    expect(sources).toContain("attribution-claim.ts");
    expect(sources).toContain("cleanup-verify.ts");
    expect(emitted.length).toBeGreaterThan(25);
    expect(emittedValues.has(ACTION_CLAIM_REASON)).toBe(true);
    expect(emittedValues.has(TOOL_SEARCH_RECOVERY_REASON)).toBe(true);
    expect(emittedValues.has(CLEANUP_VERIFY_FALSE_DONE_REASON)).toBe(true);
  });

  it("reads every nudge reason it finds", () => {
    expect(
      unreadable,
      "A nudge reason the scanner could not resolve. Emit an exported constant " +
        "(and import it into REASON_CONSTANTS), or declare the emitter in " +
        `DYNAMIC_EMITTERS. Unresolved: ${unreadable.join("; ")}`,
    ).toEqual([]);
  });

  it("every emitted nudge reason is explicitly classified", () => {
    const undeclared = emitted
      .filter((e) => !classified.has(e.value))
      .map((e) => `${e.file}:${e.line} "${e.value}"`);
    expect(
      undeclared,
      "These nudge reasons have no declared consequence. Silence is not a " +
        "decision: add the reason to RETRACTABLE_REASONS (retract-false-claim.ts) " +
        "if the next turn supersedes the text, or to NON_RETRACTABLE_REASONS here " +
        `if the text stands. Undeclared: ${undeclared.join("; ")}`,
    ).toEqual([]);
  });

  it("no reason is classified both ways", () => {
    const both = [...RETRACTABLE_REASONS].filter((r) => NON_RETRACTABLE_REASONS.has(r));
    expect(both).toEqual([]);
  });

  it("every classified reason is still emitted — a retired guard's reason cannot linger", () => {
    const dead = [...classified].filter((r) => !emittedValues.has(r));
    expect(
      dead,
      "Classified reasons no middleware emits any more. This is the " +
        "worker-hallucination / creation-hallucination failure (their middleware " +
        "was deleted in 7d524491, the reasons stayed): delete them, or restore the " +
        `emitter. Dead: ${dead.join(", ")}`,
    ).toEqual([]);
  });

  it("action-claim is explicitly NON-retractable, and the classification is what the dispatch does", () => {
    expect(NON_RETRACTABLE_REASONS.has(ACTION_CLAIM_REASON)).toBe(true);
    expect(isRetractableHallucination(ACTION_CLAIM_REASON)).toBe(false);
  });

  it("the classification matches the runtime dispatch for every classified reason", () => {
    for (const reason of RETRACTABLE_REASONS) expect(isRetractableHallucination(reason)).toBe(true);
    for (const reason of NON_RETRACTABLE_REASONS) expect(isRetractableHallucination(reason)).toBe(false);
  });

  it("no post-turn detector reason can retract via its family prefix", () => {
    const clash = [...RETRACTABLE_REASONS].filter((r) => r.startsWith(POST_TURN_FAMILY));
    expect(clash).toEqual([]);
  });
});
