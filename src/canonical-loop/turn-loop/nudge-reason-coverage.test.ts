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
 * REACH is the guard's own failure mode, and four holes were closed on
 * 2026-09-08 after each was reproduced with a probe that passed:
 *
 *   - a file named in DYNAMIC_EMITTERS was never read again, so a THIRD branch
 *     assigning a fresh literal was invisible — the guard reproducing its own
 *     bug class. Declared-dynamic files are still scanned, against their set.
 *   - the scan was a flat readdir, so a guard split into a subdirectory (which
 *     the 400-LOC gate pushes the big ones toward) vanished. It recurses now.
 *   - detection was the byte sequence `kind: "nudge"`; a single-quoted directive
 *     was invisible, and nothing in this repo enforces the quote style. Any
 *     quote, any spacing, now matches.
 *   - an interpolated template was collapsed onto its static head, so
 *     `` `browser-handoff${x}` `` inherited browser-handoff's retract verdict.
 *     Only prefixes declared in REASON_FAMILIES may be classified as a family.
 *
 * Scope is the NUDGE directive. `abort` / `suspend` reasons are a SEPARATE
 * contract on a different axis: retraction never looks at them, so listing them
 * here would mix two consequence ledgers in one set — the fold this guard
 * exists to prevent. The one suspend reason that does drive a consequence
 * (repeat-failure → `op.canonical.suspension.reason` "blocked" vs "stalled") is
 * single-sourced at its emitter as REPEAT_FAILURE_REASON and pinned end-to-end
 * by full-turn.test.ts, not by a classification here.
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
import { REPEAT_FAILURE_REASON } from "../middlewares/repeat-failure.js";
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
 * The ONLY interpolated-template prefixes that may be classified as a family.
 * An interpolated reason is not the string its static head spells: collapsing
 * `` `browser-handoff${suffix}` `` to "browser-handoff" would vouch a runtime
 * value the ledger has never seen with browser-handoff's retract consequence
 * (and the mirror-image mistake in the other direction). A template prefix that
 * is not declared here is UNREADABLE, not classified.
 */
const REASON_FAMILIES: ReadonlySet<string> = new Set([POST_TURN_FAMILY]);

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
  REPEAT_FAILURE_REASON,
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
  REPEAT_FAILURE_REASON,
  SOURCE_VERIFY_REASON,
  INSTRUCTION_OBLIGATION_REASON,
  INSTRUCTION_VIOLATION_REASON,
};

/**
 * Emitters that pick their reason at runtime, so no value can be read off the
 * `reason:` position of the directive itself. Keyed by path relative to the
 * middleware directory. Each declares every reason it can emit; those values
 * are classified like any other, and a new dynamic emitter without an entry
 * fails the scan rather than slipping through unclassified.
 *
 * A declaration means "the CHOICE happens at runtime" — NOT "stop reading this
 * file". The file is still scanned for every reason value it binds anywhere,
 * and a value outside the declared set fails (see the dynamic-emitter test
 * below). Without that, this list re-created the exact hole the whole guard
 * exists to close: a third branch assigning a brand-new unclassified reason was
 * invisible, because the scanner trusted the declaration instead of the source.
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

/** Every source file at or below `dir`, as paths relative to it. RECURSIVE on
 *  purpose: the 400-LOC hygiene gate actively pushes the big guards (open-steps,
 *  post-turn-detector, mid-turn-stale) toward a subdirectory of parts, and a
 *  flat readdir made every one of those parts invisible to this scan. */
function walkSources(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkSources(join(dir, entry.name), rel));
    else if (isSource(entry.name)) out.push(rel);
  }
  return out;
}

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
  | { kind: "family"; prefix: string }
  | { kind: "identifier"; name: string }
  | { kind: "runtime" };

/** A nudge directive in ANY quote style, with any spacing. There is no eslint /
 *  prettier / biome config and no `lint` script in this repo — double quotes are
 *  convention, not enforcement — so the byte-exact `kind: "nudge"` match this
 *  replaced simply did not see a single-quoted guard. */
const NUDGE_DIRECTIVE = /\bkind\s*:\s*(["'`])nudge\1/g;

/** A `reason` property or assignment. `===` / `!==` / `=>` are excluded so a
 *  comparison is not mistaken for a binding. */
const REASON_BINDING_SOURCE = String.raw`\breason\s*(?::|=(?![=>]))\s*`;
const REASON_BINDING = new RegExp(REASON_BINDING_SOURCE, "g");
const FIRST_REASON_BINDING = new RegExp(REASON_BINDING_SOURCE);

/** Read what a `reason` binding binds: a literal value, a named constant, an
 *  interpolated-template FAMILY (its static head), or a runtime-chosen value. */
function readReasonValue(rest: string): ReasonRef {
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
    return interp < 0 ? { kind: "value", value: raw } : { kind: "family", prefix: raw.slice(0, interp) };
  }
  const id = /^[A-Za-z_$][\w$]*/.exec(rest);
  return id ? { kind: "identifier", name: id[0] } : { kind: "runtime" };
}

/** The directive's own `reason`, read out of the object literal enclosing it. */
function readReason(objectText: string): ReasonRef {
  const key = FIRST_REASON_BINDING.exec(objectText);
  if (!key) return { kind: "runtime" }; // `{ …, reason }` shorthand off a variable
  return readReasonValue(objectText.slice(key.index + key[0].length));
}

interface Emitted { file: string; line: number; value: string }

const sources = walkSources(MIDDLEWARE_DIR).sort();
const emitted: Emitted[] = [];
const unreadable: string[] = [];
const undeclaredDynamic: string[] = [];

const lineOf = (src: string, at: number) => src.slice(0, at).split("\n").length;

/** The value a ref carries, or null — with why it could not be read appended
 *  to `sink` (its own array in the reach self-test, so probing costs nothing). */
function resolveRef(ref: ReasonRef, where: string, sink: string[] = unreadable): string | null {
  if (ref.kind === "value") return ref.value;
  if (ref.kind === "family") {
    if (REASON_FAMILIES.has(ref.prefix)) return ref.prefix;
    sink.push(`${where} template \`${ref.prefix}\${…}\` is not a declared reason family`);
    return null;
  }
  if (ref.kind === "identifier") {
    const value = REASON_CONSTANTS[ref.name];
    if (value !== undefined) return value;
    sink.push(`${where} unknown constant ${ref.name}`);
    return null;
  }
  return null;
}

for (const file of sources) {
  const src = stripComments(readFileSync(join(MIDDLEWARE_DIR, file), "utf8"));
  const declared = DYNAMIC_EMITTERS[file];

  for (const m of src.matchAll(NUDGE_DIRECTIVE)) {
    const at = m.index!;
    const line = lineOf(src, at);
    const object = objectAround(src, at);
    const ref: ReasonRef = object ? readReason(object) : { kind: "runtime" };
    if (ref.kind === "runtime") {
      if (!declared) unreadable.push(`${file}:${line} runtime-chosen reason`);
      else for (const value of declared) emitted.push({ file, line, value });
      continue;
    }
    const value = resolveRef(ref, `${file}:${line}`);
    if (value !== null) emitted.push({ file, line, value });
  }

  // The declaration says the CHOICE is dynamic, not that the file is off-limits:
  // read every reason it binds and hold each to the declared set. Removing a
  // declared reason was already caught; ADDING one — a third branch assigning a
  // fresh literal — was not, which is this guard reproducing its own bug class.
  if (!declared) continue;
  const allowed = new Set<string>(declared);
  for (const m of src.matchAll(REASON_BINDING)) {
    const line = lineOf(src, m.index!);
    const ref = readReasonValue(src.slice(m.index! + m[0].length));
    if (ref.kind === "runtime") continue; // the runtime choice itself
    let value: string;
    if (ref.kind === "value") value = ref.value;
    else if (ref.kind === "family") value = ref.prefix;
    else {
      const named = REASON_CONSTANTS[ref.name];
      if (named === undefined) {
        undeclaredDynamic.push(`${file}:${line} binds reason to ${ref.name}, not an imported reason constant`);
        continue;
      }
      value = named;
    }
    if (!allowed.has(value)) undeclaredDynamic.push(`${file}:${line} "${value}"`);
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
    // Floors sit one under the real counts (35 emissions across 28 emitters as
    // of 2026-09-08), so a guard going quiet is a deliberate edit here rather
    // than slack the scan can lose eight emitters into.
    expect(emitted.length).toBeGreaterThanOrEqual(34);
    expect(new Set(emitted.map((e) => e.file)).size).toBeGreaterThanOrEqual(27);
    expect(emittedValues.has(ACTION_CLAIM_REASON)).toBe(true);
    expect(emittedValues.has(TOOL_SEARCH_RECOVERY_REASON)).toBe(true);
    expect(emittedValues.has(CLEANUP_VERIFY_FALSE_DONE_REASON)).toBe(true);
  });

  it("the scanner's REACH — quote style, subdirectories and dynamic files cannot hide a reason", () => {
    // Quote-agnostic and whitespace-tolerant: nothing in this repo enforces the
    // double-quoted spelling the old byte-exact match required.
    for (const form of ['{ kind: "nudge" }', "{ kind: 'nudge' }", "{ kind :\n  `nudge` }"]) {
      expect([...form.matchAll(NUDGE_DIRECTIVE)], form).toHaveLength(1);
    }
    // Recursive: pointed one directory up, the walk still reaches this file's
    // neighbours inside the middlewares/ subdirectory.
    expect(walkSources(resolve(MIDDLEWARE_DIR, ".."))).toContain("middlewares/action-claim.ts");
    // An interpolated template is a FAMILY, never the reason its head spells.
    expect(readReason("{ reason: `browser-handoff${suffix}` }")).toEqual({
      kind: "family",
      prefix: "browser-handoff",
    });
    const probe: string[] = [];
    expect(resolveRef({ kind: "family", prefix: "browser-handoff" }, "probe", probe)).toBeNull();
    expect(probe).toHaveLength(1);
    expect(resolveRef({ kind: "family", prefix: POST_TURN_FAMILY }, "probe", probe)).toBe(POST_TURN_FAMILY);
  });

  it("a dynamic emitter may only bind the reasons it declared", () => {
    expect(
      undeclaredDynamic,
      "A file in DYNAMIC_EMITTERS binds a reason outside its declared set. The " +
        "declaration means the CHOICE is made at runtime, not that the file stops " +
        "being read — add the reason to that entry (and classify it), or stop " +
        `emitting it. Found: ${undeclaredDynamic.join("; ")}`,
    ).toEqual([]);
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
