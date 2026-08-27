/**
 * The ONE place a test builds a CanonicalLoopContext.
 *
 * Why this exists: every fixture in the repo used to hand-write a context
 * literal and cast it with `as unknown as CanonicalLoopContext`. That cast
 * tells TypeScript to stop checking, so adding a REQUIRED field to the
 * interface left ~30 fixtures silently short of it — `npx tsc --noEmit` exits 0
 * and the first middleware to touch the new field throws
 * "Cannot read properties of undefined" inside vitest. It happened twice in one
 * campaign: `substantiveCommittingToolsThisOp` broke 8 tests across two files,
 * and a fourth reader added while those were still red reproduced it
 * immediately. Patching fixtures one at a time is whack-a-mole; the cast is the
 * bug.
 *
 * The fix is TWO cast-free annotations, `DEFAULT_OP: Op` and `base:
 * CanonicalLoopContext`. Add a required field to either interface and `tsc`
 * fails HERE, in one place, before any test runs — and every fixture gets the
 * new field's default for free. Fixtures pass only the fields their assertion
 * is about.
 *
 * `DEFAULT_OP` being complete is not decoration. The merge below used to end in
 * `as unknown as Op` over a two-field stub, which reopened the identical
 * footgun one level down: a probe adding a required field to `Op` produced 34
 * `tsc` errors and NOT ONE of them was in a factory-built fixture, on the very
 * object whose `lane` and `type` gate `isWorkerOp`, `attribution-claim.when`,
 * `browser-handoff.when` and instruction-ledger. Object.assign carries the
 * caller's overrides on top without a cast: it returns `Op & <overrides>`,
 * which is assignable to `Op` precisely because the target is already complete.
 *
 * RESIDUAL HOLE, stated plainly so nobody reads more guarantee into this than
 * it gives: the `op` overrides stay loosely typed (fixtures legitimately
 * parameterize `lane` as a plain `string`), so a WRONG-TYPED or misspelled op
 * field in a fixture is still not a compile error — `{ op: { lane: "bogus" } }`
 * and `{ op: { laen: "agent" } }` both build. What is closed is the MISSING
 * required field, which is the one that dead-tests the whole suite at once. The
 * non-`op` overrides are `Partial<CanonicalLoopContext>`, so a typo there is
 * still caught in `src/**\/*.test.ts`.
 *
 * Defaults are deliberately NEUTRAL (empty string / empty Set / empty array /
 * turn 0), never "realistic": a fixture that omits a field must land on a value
 * that makes no middleware behave differently than the missing-field literal
 * did. That rule is why `type` and `task` default to "" rather than to a real
 * op type — "" matches no `op.type` check — and why `lane` keeps the "agent"
 * the two-field stub already used.
 *
 * Lives under src/ (not test/) on purpose: tsconfig sets `rootDir: "src"`, so a
 * `src/**\/*.test.ts` importing from outside src breaks the build. Named
 * `*.test-helper.ts` to match src/symlink-capabilities.test-helper.ts.
 */
import type { Op } from "../../ops/types.js";
import type { CanonicalLoopContext } from "./types.js";

/** Overrides accepted by makeCanonicalLoopContext. `op` is loosened to a plain
 *  record because fixtures pass partial ops (`{ id, lane }`) and parameterize
 *  `lane` as `string`; the rest stay `Partial<CanonicalLoopContext>` so a typo
 *  in a field name is still a compile error in `src/**\/*.test.ts`. */
export type CanonicalLoopContextOverrides =
  Omit<Partial<CanonicalLoopContext>, "op"> & { op?: Partial<Op> | Record<string, unknown> };

/** A COMPLETE, neutral Op — annotated, never cast, for the reason in the module
 *  docstring. Fields no middleware reads still carry their emptiest legal
 *  value; adding a required field to `Op` fails to compile right here. */
const DEFAULT_OP: Op = {
  id: "op-test",
  type: "",
  task: "",
  contextPack: {
    task: { description: "", successCriteria: [], constraints: [], notWhatToRedo: [] },
    context: { recentTurns: [], referencedFiles: [], memoryHits: [], agentsRules: "" },
    capabilities: {},
    budget: { maxIterations: 0, maxTokens: 0, maxWallTimeMs: 0, maxSelfEditCalls: 0 },
    routing: { lane: "agent" },
    secrets: { allowed: [] },
  },
  lane: "agent",
  retryPolicy: { maxRecoveryAttempts: 0, backoffMs: [] },
  ownerId: "",
  visibility: "private",
  status: "running",
  createdAt: "",
  attemptCount: 0,
};

/**
 * A complete CanonicalLoopContext with neutral defaults, plus the caller's
 * overrides. `op` is merged field-by-field over DEFAULT_OP so a fixture can
 * pass `{ id }` alone and still get a lane — and every other Op field.
 */
export function makeCanonicalLoopContext(
  over: CanonicalLoopContextOverrides = {},
): CanonicalLoopContext {
  const { op: opOver, ...rest } = over;
  const op: Op = Object.assign({ ...DEFAULT_OP }, opOver ?? {});

  // NO cast on this annotation — it is the whole point of the module. A new
  // required field on CanonicalLoopContext fails to compile right here.
  const base: CanonicalLoopContext = {
    op,
    turnIdx: 0,
    userMessage: "",
    provider: "",
    model: "",
    tools: [],
    toolNames: new Set<string>(),
    assistantContent: "",
    toolCalls: [],
    toolResults: [],
    toolsCalledThisOp: new Set<string>(),
    committingToolsThisOp: new Set<string>(),
    substantiveCommittingToolsThisOp: new Set<string>(),
    attemptedToolsThisOp: new Set<string>(),
    evidenceHistory: [],
  };

  return { ...base, ...rest, op };
}
