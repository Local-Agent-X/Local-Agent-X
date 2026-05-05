/**
 * Issue 10 — Old-path compatibility fixtures (PRD acceptance #11).
 * docs/issues/canonical-loop/10-old-path-compat-fixtures.md
 *
 * Coverage:
 *   - Each scenario fixture in `test/canonical-loop/fixtures/legacy/*.json`
 *     is replayed under both flag values.
 *   - Flag OFF: response shape matches the fixture's templated content;
 *     persisted op carries no canonical sub-object; canonical-loop
 *     artifacts (canonical-events, op-turns, op-messages) are NOT
 *     created.
 *   - Flag ON: same response shape as flag OFF; persisted op has
 *     `canonical.flagValue=true` / `canonical.state="queued"`; the
 *     canonical-events log was created with the initial `state_changed`;
 *     no legacy event-log file written at submit time.
 *   - Lane preservation: a `background`-lane fixture exercises the
 *     non-default lane env var.
 *   - Public Op fields preserved (id, type, task, lane, ownerId,
 *     visibility, status, attemptCount).
 *   - Source-drift guard: `op_submit_async`'s response-template literal
 *     in `src/workers/tools.ts` still contains the verbatim fragments
 *     the harness reproduces — any wording change here fails first.
 *   - Public control APIs (opPause/opCancel/opRedirect/opResume) are
 *     re-exported from the canonical-loop with the documented
 *     `{ ok, code, message }` envelope (smoke check; behavior tested
 *     in Issues 05–07).
 *   - No duplicate `state_changed null→queued` event on flag-ON submit
 *     (single submit emits exactly one).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  decideSubmitRouting,
  resetCanonicalRuntime,
  resetScheduler,
  resetBus,
  resetLeaseConfig,
  awaitIdle,
  opPause,
  opCancel,
  opRedirect,
  opResume,
  readCanonicalEvents,
} from "../src/canonical-loop/index.js";
import {
  harnessSubmit,
  formatSubmitResponse,
  normalizeForFixture,
  normalizeArtifactsForFixture,
  RESPONSE_TEMPLATE_FRAGMENTS,
} from "./canonical-loop/op-submit-fixtures-harness.js";
import type { OpLane } from "../src/workers/types.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const tracked: string[] = [];
const trackOpId = (id: string): string => { tracked.push(id); return id; };

const FIXTURE_DIR = join(__dirname, "canonical-loop", "fixtures", "legacy");
const TOOL_SOURCE_PATH = join(process.cwd(), "src", "workers", "tools.ts");

interface FixtureFile {
  scenario: string;
  description: string;
  args: { task?: string; type?: string; lane?: string; _taskLengthBytes?: number };
  expected: {
    response: { isError: boolean; content?: string };
    publicOp?: Record<string, unknown>;
    flagOff?: Record<string, unknown>;
    flagOn?: Record<string, unknown>;
    flagEnvVar?: string;
    noOpCreated?: boolean;
    flagIndependent?: boolean;
  };
}

function loadFixture(name: string): FixtureFile {
  const path = join(FIXTURE_DIR, `${name}.json`);
  return JSON.parse(readFileSync(path, "utf-8")) as FixtureFile;
}

function buildArgs(fixture: FixtureFile): {
  task: string;
  type?: string;
  lane?: OpLane;
} {
  const a = fixture.args;
  let task = a.task ?? "";
  if (typeof a._taskLengthBytes === "number") {
    task = "x".repeat(a._taskLengthBytes);
  }
  return { task, type: a.type, lane: a.lane as OpLane | undefined };
}

/**
 * If the fixture's publicOp uses `_taskLengthBytes` (synthesized large
 * task), normalize the captured publicOp's `task` field to its byte
 * length under the same key. Lets the fixture stay human-readable
 * without embedding 16 KB of "x"s.
 */
function normalizeForLargeTask(
  publicOp: Record<string, unknown>,
  fixturePublicOp: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!fixturePublicOp || !("_taskLengthBytes" in fixturePublicOp)) return publicOp;
  if (typeof publicOp.task !== "string") return publicOp;
  const out = { ...publicOp };
  out._taskLengthBytes = (publicOp.task as string).length;
  delete out.task;
  return out;
}

beforeEach(() => {
  delete process.env.LAX_CANONICAL_LOOP_INTERACTIVE;
  delete process.env.LAX_CANONICAL_LOOP_BUILD;
  delete process.env.LAX_CANONICAL_LOOP_BACKGROUND;
  delete process.env.LAX_CANONICAL_LOOP_IDE;
  delete process.env.LAX_CANONICAL_LOOP_ALL;
});

afterEach(async () => {
  await awaitIdle(2_000).catch(() => undefined);
  resetScheduler();
  resetCanonicalRuntime();
  resetBus();
  resetLeaseConfig();
  for (const id of tracked) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  tracked.length = 0;
  delete process.env.LAX_CANONICAL_LOOP_INTERACTIVE;
  delete process.env.LAX_CANONICAL_LOOP_BUILD;
  delete process.env.LAX_CANONICAL_LOOP_BACKGROUND;
  delete process.env.LAX_CANONICAL_LOOP_IDE;
  delete process.env.LAX_CANONICAL_LOOP_ALL;
});

// ── Source-drift guard (must run BEFORE any scenarios) ────────────────────

describe("Issue 10 — source-drift guard for op_submit_async response template", () => {
  it("every templated fragment from the fixture harness still appears verbatim in src/workers/tools.ts", () => {
    const src = readFileSync(TOOL_SOURCE_PATH, "utf-8");
    for (const fragment of RESPONSE_TEMPLATE_FRAGMENTS) {
      expect(src, `expected fragment to appear verbatim in tools.ts: ${fragment}`)
        .toContain(fragment);
    }
  });

  it("formatSubmitResponse renders the same content the tool's template produces", () => {
    // Feed the helper a deterministic op shape and confirm the rendering
    // matches what op_submit_async would emit. (No assertion against the
    // tool's runtime here — the source-drift guard above covers the literal
    // fragments; this test guards the harness's renderer.)
    const out = formatSubmitResponse({ id: "op_X", type: "freeform", lane: "interactive" });
    expect(out).toBe(
      'op op_X submitted (type=freeform, lane=interactive).\n' +
      'Running in background — you can keep responding to the user. ' +
      'The user will see a notification when it completes.\n' +
      'Inspect anytime: op_status(op_id="op_X")  |  block on it: op_wait(op_id="op_X")',
    );
  });
});

// ── Per-scenario replay ──────────────────────────────────────────────────

const HAPPY_FIXTURES = ["text-only", "tool-using", "background-lane", "large-input"] as const;

describe.each(HAPPY_FIXTURES)("Issue 10 — fixture replay: %s", (name) => {
  it("flag OFF response + artifacts match the fixture's flagOff snapshot", () => {
    const fixture = loadFixture(name);
    const args = buildArgs(fixture);
    if (fixture.expected.flagEnvVar) {
      delete process.env[fixture.expected.flagEnvVar];
    }

    const result = harnessSubmit(args);
    trackOpId(result.opId);

    expect(result.route).toBe("legacy");
    expect(result.flagValue).toBe(false);

    // Response shape — byte-identical after <OPID> normalization.
    expect(result.response.isError).toBe(fixture.expected.response.isError);
    expect(normalizeForFixture(result.response.content, result.opId))
      .toBe(fixture.expected.response.content);

    // Public op fields.
    const normArt = normalizeArtifactsForFixture(result.artifacts, result.opId);
    const publicOp = normalizeForLargeTask(normArt.publicOp, fixture.expected.publicOp);
    expect(publicOp).toEqual(fixture.expected.publicOp);

    // Flag-OFF artifact-presence snapshot.
    const off = fixture.expected.flagOff!;
    expect(result.artifacts.operationJsonPresent).toBe(off.operationJsonPresent);
    expect(result.artifacts.opCanonical).toEqual(off.opCanonical);
    expect(result.artifacts.canonicalEventsExists).toBe(off.canonicalEventsExists);
    expect(result.artifacts.canonicalEventTypes).toEqual(off.canonicalEventTypes);
    expect(result.artifacts.opTurnsDirExists).toBe(off.opTurnsDirExists);
    expect(result.artifacts.opMessagesExists).toBe(off.opMessagesExists);
  });

  it("flag ON response + artifacts match the fixture's flagOn snapshot", () => {
    const fixture = loadFixture(name);
    const args = buildArgs(fixture);
    const envVar = fixture.expected.flagEnvVar ?? "LAX_CANONICAL_LOOP_INTERACTIVE";
    process.env[envVar] = "1";

    const result = harnessSubmit(args);
    trackOpId(result.opId);

    expect(result.route).toBe("canonical");
    expect(result.flagValue).toBe(true);

    // Response shape — byte-identical after <OPID> normalization.
    // Hard rule per PRD §17: flag ON returns the SAME response shape as
    // flag OFF. The fixture's `expected.response.content` is a single
    // string used for both flag values.
    expect(result.response.isError).toBe(fixture.expected.response.isError);
    expect(normalizeForFixture(result.response.content, result.opId))
      .toBe(fixture.expected.response.content);

    // Public op fields.
    const normArt = normalizeArtifactsForFixture(result.artifacts, result.opId);
    const publicOp = normalizeForLargeTask(normArt.publicOp, fixture.expected.publicOp);
    expect(publicOp).toEqual(fixture.expected.publicOp);

    // Flag-ON artifact-presence snapshot.
    const on = fixture.expected.flagOn!;
    expect(result.artifacts.operationJsonPresent).toBe(on.operationJsonPresent);
    expect(result.artifacts.opCanonical).toEqual(on.opCanonical);
    expect(result.artifacts.canonicalEventsExists).toBe(on.canonicalEventsExists);
    expect(result.artifacts.canonicalEventTypes).toEqual(on.canonicalEventTypes);
    expect(result.artifacts.opTurnsDirExists).toBe(on.opTurnsDirExists);
    expect(result.artifacts.opMessagesExists).toBe(on.opMessagesExists);
    expect(result.artifacts.legacyEventsExists).toBe(on.legacyEventsExists);
  });
});

// ── Cross-flag invariants ────────────────────────────────────────────────

describe("Issue 10 — cross-flag invariants", () => {
  it("response content is byte-identical after normalization between flag OFF and flag ON", () => {
    delete process.env.LAX_CANONICAL_LOOP_INTERACTIVE;
    const off = harnessSubmit({ task: "Reply with: ok.", type: "freeform", lane: "interactive" });
    trackOpId(off.opId);
    process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
    const on = harnessSubmit({ task: "Reply with: ok.", type: "freeform", lane: "interactive" });
    trackOpId(on.opId);

    expect(off.route).toBe("legacy");
    expect(on.route).toBe("canonical");

    const offNorm = normalizeForFixture(off.response.content, off.opId);
    const onNorm = normalizeForFixture(on.response.content, on.opId);
    expect(onNorm).toBe(offNorm);
    expect(off.response.isError).toBe(on.response.isError);
  });

  it("flag OFF never writes canonical artifacts; flag ON never writes legacy events.jsonl at submit time", () => {
    delete process.env.LAX_CANONICAL_LOOP_INTERACTIVE;
    const off = harnessSubmit({ task: "off-only", type: "freeform", lane: "interactive" });
    trackOpId(off.opId);
    expect(off.artifacts.canonicalEventsExists).toBe(false);
    expect(off.artifacts.opTurnsDirExists).toBe(false);
    expect(off.artifacts.opMessagesExists).toBe(false);

    process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
    const on = harnessSubmit({ task: "on-only", type: "freeform", lane: "interactive" });
    trackOpId(on.opId);
    expect(on.artifacts.canonicalEventsExists).toBe(true);
    expect(on.artifacts.legacyEventsExists).toBe(false);
  });

  it("flag ON canonical event log starts with exactly one state_changed null→queued (no duplicates)", () => {
    process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
    const r = harnessSubmit({ task: "Once.", type: "freeform", lane: "interactive" });
    trackOpId(r.opId);

    const events = readCanonicalEvents(r.opId);
    const stateChanged = events.filter(e => e.type === "state_changed");
    expect(stateChanged).toHaveLength(1);
    const body = stateChanged[0].body as { from: string | null; to: string };
    expect(body.from).toBeNull();
    expect(body.to).toBe("queued");
  });

  it("opPause / opCancel / opRedirect / opResume return the documented control envelope", () => {
    process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
    const r = harnessSubmit({ task: "Control surface check.", type: "freeform", lane: "interactive" });
    trackOpId(r.opId);

    // No adapter registered, so the worker microtask will fail-safe to
    // `failed` shortly. We validate the public control envelopes BEFORE
    // that microtask fires (synchronous tests on the canonical state).
    const pauseAck = opPause(r.opId, "compat-test");
    expect(pauseAck.ok).toBe(true);

    const redirectAck = opRedirect(r.opId, "go a different way", "compat-test");
    expect(redirectAck.ok).toBe(true);

    const resumeAck = opResume(r.opId, "compat-test");
    // Resume on a queued (not paused) op returns a typed error.
    expect(resumeAck.ok).toBe(false);
    if (!resumeAck.ok) expect(resumeAck.code).toBe("not_paused");

    const cancelAck = opCancel(r.opId, "compat-test");
    // Cancel may succeed (queued → cancelled) or report terminal if the
    // missing-adapter fail-safe already fired. Both shapes are part of
    // the documented envelope; we only assert the envelope shape.
    expect(typeof cancelAck.ok).toBe("boolean");
    if (!cancelAck.ok) {
      expect(["unknown_op", "invalid_op_id", "terminal"]).toContain(cancelAck.code);
    }
  });
});

// ── Routing decision shape ──────────────────────────────────────────────

describe("Issue 10 — decideSubmitRouting shape preserved", () => {
  it("returns { route, flagValue, lane } with route ∈ {legacy, canonical}", () => {
    delete process.env.LAX_CANONICAL_LOOP_INTERACTIVE;
    const off = decideSubmitRouting({ lane: "interactive" });
    expect(off).toMatchObject({ route: "legacy", flagValue: false, lane: "interactive" });

    process.env.LAX_CANONICAL_LOOP_INTERACTIVE = "1";
    const on = decideSubmitRouting({ lane: "interactive" });
    expect(on).toMatchObject({ route: "canonical", flagValue: true, lane: "interactive" });
  });
});

// ── Error-input scenario (early return; flag-independent) ───────────────

describe("Issue 10 — error-input fixture (early return is flag-independent)", () => {
  it("an empty task produces the recorded error envelope, regardless of flag value", () => {
    const fixture = loadFixture("error-input");
    expect(fixture.expected.response.isError).toBe(true);

    // The tool's early-return path is a pure string return; no Op is
    // built, no routing happens, no disk write. The harness exists only
    // for the success path (Op + routing). For the error path, we
    // assert the literal error string is what op_submit_async returns —
    // proven by source inspection (the response is a constant in
    // tools.ts).
    const src = readFileSync(TOOL_SOURCE_PATH, "utf-8");
    expect(src).toContain('"op_submit_async requires a \'task\' description."');
    expect(fixture.expected.response.content).toBe(
      "op_submit_async requires a 'task' description.",
    );
  });
});
