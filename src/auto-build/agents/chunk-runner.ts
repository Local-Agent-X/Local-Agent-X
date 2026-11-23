/**
 * Chunk worker invocation via the canonical agent path.
 *
 * Builds an ad-hoc AgentDefinition with the relevant skill methodology +
 * chunk-runner discipline baked into systemPrompt, dispatches it through
 * invokeDefinition (canonical-loop driver — see src/agents/runtime.ts +
 * src/server/handler-events.ts), awaits completion via the
 * "handler:agent-result" EventBus event. The result fires after the
 * underlying canonical op reaches a terminal state.
 *
 * Roles exposed:
 *   - "chunk-runner-trunk" — /senior-engineer methodology, for trunk + mixed
 *   - "chunk-runner-leaf"  — /vibe-code methodology, for leaf
 *   - "scenario-fix"       — /senior-engineer + scenario-fix constraints
 *   - "chunk-skeptic"      — no methodology; tries to prove a chunk wrong, read + run only
 *
 * The systemPrompt is computed at first invocation per role and cached.
 * Skill body comes from `src/protocols/bundled/<name>/SKILL.md` (the same
 * source the Protocols browser scans).
 *
 * Returns a {stdout, exitCode, durationMs, error?} envelope matching the
 * shape `SubprocessResult` had, so the loop's downstream review code
 * doesn't have to learn a new contract. The chunk subprocess's free-form
 * stdout is now the agent's final result message.
 */

import { invokeDefinition } from "../../agents/invoke.js";
import type { AgentDefinition } from "../../agents/types.js";
import { EventBus } from "../../event-bus.js";
import { Handler } from "../../agency/handler.js";
import { loadSkillBody } from "../skill-bodies.js";
import { CODING_KIT, REVIEW_KIT } from "../../tools/tool-kits.js";
import { join } from "node:path";

export type ChunkAgentRole = "chunk-runner-trunk" | "chunk-runner-leaf" | "scenario-fix" | "chunk-skeptic";

export interface ChunkAgentInvocation {
  role: ChunkAgentRole;
  /** The chunk-specific task body (slice, done-when, retry framing, etc).
   *  System prompt + discipline lives in the AgentDefinition. */
  task: string;
  /** What this run is, in a few words ("Chunk 3/13: Checkout"): the run's
   *  name in the agents panel and the first line of its task. */
  title?: string;
  /** Absolute path to the PROJECT directory the agent works in.
   *  Without this, the agent runs from the LAX repo root and can't
   *  find the project's app/ tree. (Live failure 2026-05-12: chunk
   *  blocked with "apps/ missing" because the worker looked for
   *  monorepo structure inside the LAX repo, not the project.) */
  projectDir?: string;
  /** Originating chat session — propagated for sidebar attribution. */
  parentSessionId?: string;
  /** Orchestrator op id — passed to invokeDefinition as the spawn's
   *  parentAgentId. It rides the `handler:agent-spawn` event to the client,
   *  which stamps it as the worker card's parentOpId so the panel nests this
   *  chunk-runner card under the orchestrator card (whose id === this opId).
   *  Undefined → no parent linkage (parentAgentId null) → card renders as a
   *  root, unchanged. */
  parentOpId?: string;
  /** How long the run may go silent — no streamed output, no tool call —
   *  before it is ended as hung. Default 30 min. Not a cap on a working run:
   *  every output or tool call starts the count again. A run that keeps
   *  working without getting anywhere is the work check-in's to end
   *  (canonical-loop/work-check-in.ts: no file changed in 72 tool calls). */
  silenceLimitMs?: number;
  /** A hard cap on the whole run, for a probe that must answer quickly (the
   *  build preflight). Unset for real work. */
  deadlineMs?: number;
  /** Caller cancellation. Maps to the agent's abort signal via Handler. */
  signal?: AbortSignal;
}

export interface ChunkAgentResult {
  /** Final agent output (the worker's STATUS / DONE_WHEN / NOTE block). */
  stdout: string;
  /** 0 on clean completion, non-zero on error (mirrors SubprocessResult). */
  exitCode: number;
  /** Wall-clock duration. */
  durationMs: number;
  /** Error message when exitCode !== 0. */
  error?: string;
}

/**
 * How long a worker may go without streaming a word or calling a tool. A fixed
 * 30-minute deadline used to end every chunk run, working or not: label-check's
 * chunk 3 worker was editing (41 tool calls, the last seconds before the
 * cutoff) when it was killed, and its report was lost (2026-11-23). Spawned
 * agents run with no wall clock (server/handler-events.ts wallClockMs: 0);
 * this only catches a run that has gone silent, which the work check-in
 * cannot see because it counts turns.
 */
const DEFAULT_SILENCE_LIMIT_MS = 30 * 60_000;

const DISCIPLINE_BLOCK =
  `## Discipline (load-bearing — do not skip)\n\n` +
  `- **You are a non-interactive worker.** No human is watching. Don't pause to ask, ` +
  `don't request a planning conversation, don't wait for confirmation. If you'd normally ` +
  `ask the user, surface it in the final report's NOTE field and ship the safest available choice.\n` +
  `- **Build from \`spec/\`.** The acceptance scenarios this build is scored against are sealed ` +
  `outside the project, and no tool can read them: the spec is the whole of what you build to. ` +
  `\`twins/\`, when present, are stand-ins for external services; use them.\n` +
  `- **Code matches spec, never the reverse.** If the spec is unclear, STOP and surface the ` +
  `ambiguity in your final report. Do not weaken done-when to fit your implementation.\n` +
  `- **Minimum change.** Implement what the assigned task requires. No refactoring of neighbors, ` +
  `no unrelated abstractions.\n` +
  `- **Run the tests.** If done-when names tests, those tests must pass before you report done. ` +
  `Don't mark deferred verifications as done — name them explicitly in NOTE so the reviewer can ` +
  `route to launch-readiness.\n` +
  `- **Missing third-party credentials are never blockers.** If a service key/URL isn't configured ` +
  `(Supabase, Stripe, etc.): put clearly-fake placeholder values in the framework's local env file ` +
  `(e.g. .env.local), make client construction tolerate them — build and dev boot must succeed ` +
  `without the real service, never throw at import time — implement everything that doesn't need ` +
  `the live service, list the real-credential setup/verify steps in LAUNCH_READINESS (exact env ` +
  `var names), and report DONE_WHEN: deferred-to-launch-readiness instead of blocked/partial. ` +
  `Placeholders must be plain low-entropy words (placeholder-anon-key), NEVER realistic-looking ` +
  `tokens or JWTs — realistic fakes trip the secret-shape detectors and get your shell blocked.\n` +
  `- **Don't touch \`spec/\`.** Spec amendments are the reviewer's job. Surface gaps in NOTE.\n\n` +
  `## Report format (the review pass parses this — keep it exact)\n\n` +
  `When you finish, reply with EXACTLY this block (no other text after it). ` +
  `Your run's LAST message must be this block by itself: never end the run on a ` +
  `tool call — after your final task_update, send the report as plain text. ` +
  `Column-0 UPPERCASE field lines, no bold, no bullets, no code fence:\n\n` +
  `STATUS: done | blocked | partial\n` +
  `DONE_WHEN: met | deferred-to-launch-readiness | unmet\n` +
  `CHANGED: <comma-separated file paths>\n` +
  `TESTS: <pass-count>/<total-count> | n/a\n` +
  `NEW_FAILURES: <test names introduced by this chunk, or none>\n` +
  `PRE_EXISTING_FAILURES: <test names that already failed before this chunk, or none>\n` +
  `SPEC_GAPS: <constraints you found missing that should be added to spec, or none>\n` +
  `LAUNCH_READINESS: <items requiring real third-party creds / HTTPS / prod data, or none — each item must have "how to verify" steps>\n` +
  `NOTE: <anything the user needs to know>`;

const SCENARIO_FIX_DISCIPLINE_BLOCK =
  `## Scenario-fix constraints — DO NOT VIOLATE\n\n` +
  `1. **Code matches spec, never the reverse.** If the scenario fails because the spec is wrong, ` +
  `STOP and report STATUS: blocked with a clear SPEC_GAPS entry. The reviewer decides whether to amend additively.\n` +
  `2. **No \`spec/\` edits.** You may NOT touch any file under spec/. The orchestrator owns spec changes.\n` +
  `3. **No test bypassing.** If a test fails because the code is wrong, fix the code. Do not relax ` +
  `assertions, comment out tests, or stub returns to make a test pass.\n` +
  `4. **No silent fallback.** A scenario failure about user-visible behavior gets a real fix, not a quiet swallow.\n` +
  `5. **Don't break passing scenarios.** Your fix must keep the currently-passing list passing.\n\n` +
  `## Report format — same as chunk-runner\n\n` +
  `STATUS / DONE_WHEN / CHANGED / TESTS / NEW_FAILURES / PRE_EXISTING_FAILURES / SPEC_GAPS / LAUNCH_READINESS / NOTE`;

/** The skeptic's probe folder, at the root of the tree it reviews: its `write`
 *  is fenced there, git never sees it, and it is deleted after the run. */
export const SKEPTIC_PROBE_DIR = ".skeptic";

// The /greenfield skill's skeptic (references/autonomous.md, section 6): a
// model is a poor critic of its own work, so this one starts from "it is
// broken" and has to be talked out of it by evidence it gathers itself.
const SKEPTIC_DISCIPLINE_BLOCK =
  `# Chunk skeptic\n\n` +
  `Another agent just built one chunk of an app and says it is done and correct. Your job is to ` +
  `PROVE IT WRONG. You are not here to fix anything: you cannot edit the project, and \`write\` writes only ` +
  `in \`${SKEPTIC_PROBE_DIR}/\` at the project root, your scratch folder for probe tests.\n\n` +
  `## Mandate\n\n` +
  `- Read the change: run \`git diff <pre-chunk sha>\` and \`git status\` in the project (the sha is in your task), ` +
  `then read what the diff touches and what calls it.\n` +
  `- Hunt for: the input it breaks on, the case it missed, the existing seam it forked instead of ` +
  `extending, the test that cannot fail, a claim in the builder's report the code does not back.\n` +
  `- Show it, do not assert it: run the tests, run the code with the breaking input, cite file:line. ` +
  `To test a suspicion, \`write\` a probe test into \`${SKEPTIC_PROBE_DIR}/\` (e.g. \`${SKEPTIC_PROBE_DIR}/probe.test.ts\`, ` +
  `importing the code under test by relative path) and run it with the project's own test runner by its path ` +
  `(\`npx jest ${SKEPTIC_PROBE_DIR}/probe.test.ts\`, \`npx vitest run ${SKEPTIC_PROBE_DIR}/probe.test.ts\`). ` +
  `The folder is deleted when you finish and is never part of the change. A break you ran beats one you traced.\n` +
  `- Judge against the chunk's slice and done-when and the project's \`spec/\`, not against your taste. ` +
  `Style you would have written differently is not a break.\n` +
  `- Default to broken if unsure: HOLDS means you tried and the change survived.\n\n` +
  `## Verdict format (parsed — keep it exact)\n\n` +
  `Your run's LAST message is exactly this, column-0 lines, nothing after:\n\n` +
  `VERDICT: BROKEN | HOLDS\n` +
  `FINDING: <BROKEN: what breaks, the input or case, file:line, and how you showed it. HOLDS: what you tried.>`;

/** What each role is: the methodology skill it inherits (none for the
 *  skeptic, which builds nothing), its closing discipline, its tools, and its
 *  card. The skeptic gets no write or edit tool: it shows a break, it does not
 *  fix one. */
interface RoleSpec {
  skill: "senior-engineer" | "vibe-code" | null;
  discipline: string;
  agentRole: string;
  tools: readonly string[];
  name: string;
  description: string;
  icon: string;
}

const ROLE_SPECS: Record<ChunkAgentRole, RoleSpec> = {
  "chunk-runner-trunk": {
    skill: "senior-engineer", discipline: DISCIPLINE_BLOCK, agentRole: "implementer", tools: CODING_KIT,
    name: "Chunk runner (trunk/mixed)", description: "Implements a trunk or mixed chunk from a build plan.", icon: "🏗️",
  },
  "chunk-runner-leaf": {
    skill: "vibe-code", discipline: DISCIPLINE_BLOCK, agentRole: "implementer", tools: CODING_KIT,
    name: "Chunk runner (leaf)", description: "Implements a leaf chunk (UI, isolated features) from a build plan.", icon: "🎨",
  },
  "scenario-fix": {
    skill: "senior-engineer", discipline: SCENARIO_FIX_DISCIPLINE_BLOCK, agentRole: "implementer", tools: CODING_KIT,
    name: "Scenario fix worker", description: "Fixes phase-gate scenario failures without violating spec/constitution.", icon: "🔧",
  },
  "chunk-skeptic": {
    skill: null, discipline: SKEPTIC_DISCIPLINE_BLOCK, agentRole: "reviewer", tools: REVIEW_KIT,
    name: "Chunk skeptic", description: "Tries to prove a just-built chunk wrong before it counts as done.", icon: "🔍",
  },
};

const DEF_CACHE = new Map<ChunkAgentRole, AgentDefinition>();

function getDefinition(role: ChunkAgentRole): AgentDefinition {
  const cached = DEF_CACHE.get(role);
  if (cached) return cached;

  const spec = ROLE_SPECS[role];
  const methodology = spec.skill
    ? `# Worker methodology — /${spec.skill}\n\n` +
      `Load-bearing methodology this worker inherits. Read it before touching code; ` +
      `it's the discipline the review pass enforces against.\n\n` +
      `---\n\n${loadSkillBody(spec.skill)}\n\n---\n\n`
    : "";

  const def: AgentDefinition = {
    id: `builtin-${role}`,
    name: spec.name,
    role: spec.agentRole,
    systemPrompt: methodology + spec.discipline,
    allowedTools: [...spec.tools],
    description: spec.description,
    icon: spec.icon,
  };
  DEF_CACHE.set(role, def);
  return def;
}

/**
 * Run one chunk worker via the canonical agent path. Resolves when the
 * agent reaches a terminal state (done / error / cancelled / timeout).
 *
 * Provider selection is handled by LAX's adapter layer — whatever the
 * user has selected for the chat applies. No provider awareness in this
 * code; the same call works for Anthropic, Codex, etc.
 */
export async function runChunkAgent(opts: ChunkAgentInvocation): Promise<ChunkAgentResult> {
  // Unfenced, the skeptic's write would reach the whole work area.
  if (opts.role === "chunk-skeptic" && !opts.projectDir) {
    return { stdout: "", exitCode: 1, durationMs: 0, error: "the chunk skeptic needs the project folder it reviews" };
  }
  const def = getDefinition(opts.role);
  const startedAt = Date.now();
  const silenceLimitMs = opts.silenceLimitMs ?? DEFAULT_SILENCE_LIMIT_MS;

  // Prepend a working-directory anchor so the agent doesn't look for
  // the project tree inside the LAX repo root. This is load-bearing —
  // without it, the agent's `bash`/`read`/`glob` calls run from wherever
  // the server was started (LAX repo) and it can't find the project.
  // Forward slashes on purpose: a raw Windows path inside an unquoted
  // bash command loses its backslashes (`cd C:\Users\...` → "C:Users...",
  // live failure 2026-07-02), and every shell + Node path API on Windows
  // accepts the forward-slash form.
  const projectRootFwd = opts.projectDir?.replace(/\\/g, "/");
  const taskWithCwd = opts.projectDir
    ? `## Working directory\n\n` +
      `Your project root is: \`${projectRootFwd}\`\n\n` +
      `**ALL file paths in this chunk are relative to that directory** — file tools ` +
      `(read/write/edit/glob) resolve relative paths against it automatically. For bash, ` +
      `\`cd "${projectRootFwd}"\` first (keep the quotes and forward slashes). The plan ` +
      `file, spec/, source files, and tests all live under that root. Never touch paths ` +
      `outside it, and don't look for the project in the LAX repo or the LAX workspace root.\n\n` +
      `---\n\n${opts.task}`
    : opts.task;
  // The title leads the task: the agents panel, the work claims and the logs
  // name a run by its task's first line, and "## Working directory" named
  // every build worker the same (label-check, 2026-11-21).
  const fullTask = opts.title ? `${opts.title}\n\n${taskWithCwd}` : taskWithCwd;

  const ref = invokeDefinition(def, fullTask, {
    ...(opts.title ? { nameOverride: opts.title } : {}),
    parentSessionId: opts.parentSessionId,
    // The orchestrator run's op id becomes this worker's spawn parent, so its
    // AGENTS-panel card nests under the orchestrator card. invokeDefinition
    // forwards parentAgentId onto the handler:agent-spawn event (invoke.ts:98,
    // :123), which handler-events.ts broadcasts to the client. undefined =
    // no parent → the card renders as a root exactly as before.
    parentAgentId: opts.parentOpId,
    // Register the project dir as this run's sanctioned mutation root —
    // without it the delegated-bash/write gate blocks the worker (live
    // failure 2026-07-01: chunk 1 denied "requires worktree isolation").
    workRoot: opts.projectDir,
    // The skeptic's `write` reaches its probe folder only: it must not change
    // the code it reviews.
    ...(opts.role === "chunk-skeptic" ? { writesOnlyUnder: join(opts.projectDir!, SKEPTIC_PROBE_DIR) } : {}),
    // The task (preamble included) is harness prose, not user speech — without
    // this, the instruction ledger reads "Never touch paths outside it" as a
    // user workspace-write ban and every worker write is hard-denied (live
    // failure 2026-07-22: Merchhelm preflight halt).
    harnessAuthoredTask: true,
  });
  const agentId = ref.runId;

  return await new Promise<ChunkAgentResult>((resolve) => {
    let settled = false;
    // When we bail early (timeout/abort) the local promise resolves, but the
    // underlying canonical run keeps executing — still editing the SAME
    // projectDir and burning tokens indefinitely. Cancelling it aborts the
    // driver's signal so a subsequent retry can't interleave writes with an
    // orphaned first run (AB-1). Natural agent-result completion passes
    // `cancelRun: false` — the run is already terminal, so cancelAgent would
    // be a redundant no-op.
    const finish = (result: ChunkAgentResult, cancelRun = false) => {
      if (settled) return;
      settled = true;
      EventBus.off("handler:agent-result", resultHandler);
      EventBus.off("handler:agent-output", activityHandler);
      clearTimeout(silence);
      clearTimeout(deadline);
      opts.signal?.removeEventListener("abort", abortListener);
      if (cancelRun) Handler.getInstance().cancelAgent(agentId);
      resolve(result);
    };

    const resultHandler = (data: unknown): void => {
      const d = data as { agentId: string; result?: string; success?: boolean; error?: string; chunk?: string };
      if (d.agentId !== agentId) return;
      if (d.chunk) return; // streaming chunks — wait for the final result
      if (d.success === false) {
        finish({ stdout: d.result || "", exitCode: 1, durationMs: Date.now() - startedAt, error: d.error || d.result || "agent failed" });
      } else {
        finish({ stdout: d.result || "", exitCode: 0, durationMs: Date.now() - startedAt });
      }
    };

    EventBus.on("handler:agent-result", resultHandler);

    // Every streamed word and every tool call is the run being alive.
    const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;
    const onSilence = () => finish({
      stdout: "", exitCode: 124, durationMs: Date.now() - startedAt,
      error: `chunk agent went silent: no output or tool call for ${minutes(silenceLimitMs)}`,
    }, true);
    let silence = setTimeout(onSilence, silenceLimitMs);
    const activityHandler = (data: unknown): void => {
      if ((data as { agentId?: string }).agentId !== agentId || settled) return;
      clearTimeout(silence);
      silence = setTimeout(onSilence, silenceLimitMs);
    };
    EventBus.on("handler:agent-output", activityHandler);
    const deadline = opts.deadlineMs === undefined ? undefined : setTimeout(() => {
      finish({ stdout: "", exitCode: 124, durationMs: Date.now() - startedAt, error: `chunk agent ran past its ${minutes(opts.deadlineMs!)} deadline` }, true);
    }, opts.deadlineMs);

    const abortListener = () => {
      finish({ stdout: "", exitCode: 130, durationMs: Date.now() - startedAt, error: "aborted by caller" }, true);
    };
    if (opts.signal) {
      if (opts.signal.aborted) abortListener();
      else opts.signal.addEventListener("abort", abortListener, { once: true });
    }
  });
}

/** Test-only helper to inspect/reset the definition cache. */
export function _clearChunkAgentDefCache(): void { DEF_CACHE.clear(); }
