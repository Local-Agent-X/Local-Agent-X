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
 *   - "finish-breaker"     — no methodology; attacks the finished app from one angle, read + run only
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

import { killSessionsStartedBy } from "../../tools/process-session.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { invokeDefinition, takeRunTranscript } from "../../agents/invoke.js";
import type { AgentDefinition } from "../../agents/types.js";
import { EventBus } from "../../event-bus.js";
import { Handler } from "../../agency/handler.js";
import { loadSkillBody } from "../skill-bodies.js";
import { BUILDER_KIT, REVIEW_KIT } from "../../tools/tool-kits.js";
import { SKEPTIC_BAR_BLOCK } from "../chunk-review/skeptic-bar.js";
import { openReportSlot, takeReport, type BreakerFindingsCall, type ChunkReportCall, type ReportKind, type SkepticVerdictCall } from "./agent-report.js";
import { join } from "node:path";

export type ChunkAgentRole = "chunk-runner-trunk" | "chunk-runner-leaf" | "scenario-fix" | "chunk-skeptic" | "finish-breaker";

/** Roles that show a break and fix nothing: their `write` reaches the probe
 *  folder only, and they cannot run without the project they review. */
function probesOnly(role: ChunkAgentRole): boolean {
  return role === "chunk-skeptic" || role === "finish-breaker";
}

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
  /** The conversation of the worker that built the last round: this run is
   *  that worker going on, `task` its next message (InvokeOpts.priorMessages). */
  priorMessages?: ChatCompletionMessageParam[];
  /** Return this run's conversation, so a next round can go on from it. */
  keepTranscript?: boolean;
  /** The files the plan gives this chunk, claimed for it from the start, so a
   *  sibling worker that writes into one is told at once whose it is. Declared
   *  files were never claimed: a chunk that strayed into a sibling's files
   *  met it only as a merge conflict (label-check-grok chunks 6 and 7,
   *  2026-11-26). */
  touches?: string[];
}

export interface ChunkAgentResult {
  /** What the agent said in text. Its report is not here: see chunkReport and the like below. */
  stdout: string;
  /** 0 on clean completion, non-zero on error (mirrors SubprocessResult). */
  exitCode: number;
  /** Wall-clock duration. */
  durationMs: number;
  /** Error message when exitCode !== 0. */
  error?: string;
  /** The run's conversation, when asked for and the run finished. */
  transcript?: ChatCompletionMessageParam[];
  /** What the run reported with its report tool (agent-report.ts), by role:
   *  kept however the run ended, so a report made before a timeout or a text
   *  guard's "failed" is not lost. Absent when it made none. */
  chunkReport?: ChunkReportCall;
  skepticVerdict?: SkepticVerdictCall;
  breakerFindings?: BreakerFindingsCall;
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
  `ask the user, put the question in your report's owner_question and ship the safest available choice.\n` +
  `- **Build from \`spec/\`.** The acceptance scenarios this build is scored against are sealed ` +
  `outside the project, and no tool can read them: the spec is the whole of what you build to. ` +
  `\`twins/\`, when present, are stand-ins for external services; use them.\n` +
  `- **Code matches spec, never the reverse.** If the spec is unclear, STOP and surface the ` +
  `ambiguity in your final report. Do not weaken done-when to fit your implementation.\n` +
  `- **Minimum change.** Implement what the assigned task requires. No refactoring of neighbors, ` +
  `no unrelated abstractions.\n` +
  `- **Run the tests.** If done-when names tests, those tests must pass before you report done. ` +
  `Don't mark a check you could not make as done: list it in your report's launch_readiness with how ` +
  `to make it.\n` +
  `- **More tools are one search away.** You start with files, the shell and the web. \`tool_search\` loads the rest ` +
  `when the work needs it: the phone or emulator (\`android\`), a browser, an API (\`http_request\`), office files, and ` +
  `\`process_start\` for a dev server or anything else that must keep running. Use \`process_start\`, never \`&\` in the ` +
  `shell: what it starts is stopped for you when you finish. A send or a publish waits for the owner.\n` +
  `- **Missing third-party credentials are never blockers.** If a service key/URL isn't configured ` +
  `(Supabase, Stripe, etc.): put clearly-fake placeholder values in the framework's local env file ` +
  `(e.g. .env.local), make client construction tolerate them — build and dev boot must succeed ` +
  `without the real service, never throw at import time — implement everything that doesn't need ` +
  `the live service, list the real-credential setup/verify steps in your report's launch_readiness ` +
  `(exact env var names), and report done_when "deferred" instead of blocked or partial. ` +
  `Placeholders must be plain low-entropy words (placeholder-anon-key), NEVER realistic-looking ` +
  `tokens or JWTs — realistic fakes trip the secret-shape detectors and get your shell blocked.\n` +
  `- **Don't touch \`spec/\`.** Spec amendments are the reviewer's job. Put a gap in your report's spec_gaps.\n` +
  `- **A command this machine refuses is not your bug.** If the operating system or a policy blocks a command ` +
  `(it says so in what it prints), do not rewrite code to get around it and do not retry it: list it in your ` +
  `report's machine_blocked with what it printed, and finish everything else.\n` +
  `- **The independent review is the engine's, after you.** Once you report, the build engine runs the ` +
  `build and tests, sends a separate skeptic agent at your change, and judges the held-out scenarios. Do not ` +
  `try to run, dispatch or wait for that review, and do not report partial or blocked for it: when your ` +
  `done-when is met, report status "done".\n\n` +
  `## Your report\n\n` +
  `End your run by calling \`chunk_report\`: it is the last thing you do, after your final task_update, and ` +
  `your run ends with it. Its fields say what each is for. Do not write the report as text, and do not report ` +
  `test counts or the files you changed: the engine runs the build and tests and reads the changes from git.`;

const SCENARIO_FIX_DISCIPLINE_BLOCK =
  `## Scenario-fix constraints — DO NOT VIOLATE\n\n` +
  `1. **Code matches spec, never the reverse.** If the scenario fails because the spec is wrong, ` +
  `STOP and report status "blocked" with the gap in spec_gaps. The reviewer decides whether to amend additively.\n` +
  `2. **No \`spec/\` edits.** You may NOT touch any file under spec/. The orchestrator owns spec changes.\n` +
  `3. **No test bypassing.** If a test fails because the code is wrong, fix the code. Do not relax ` +
  `assertions, comment out tests, or stub returns to make a test pass.\n` +
  `4. **No silent fallback.** A scenario failure about user-visible behavior gets a real fix, not a quiet swallow.\n` +
  `5. **Don't break passing scenarios.** Your fix must keep the currently-passing list passing.\n\n` +
  `## Your report\n\n` +
  `End your run by calling \`chunk_report\`: it is the last thing you do.`;

/** The skeptic's probe folder, at the root of the tree it reviews: its `write`
 *  is fenced there, git never sees it, and it is deleted after the run. */
export const SKEPTIC_PROBE_DIR = ".skeptic";

// The /greenfield skill's skeptic (references/autonomous.md, section 6): a
// model is a poor critic of its own work, so this one attacks the change with
// evidence it gathers itself. What it may hold the chunk to is the chunk's
// contract and nothing more (chunk-review/skeptic-bar.ts).
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
  `The folder is deleted when you finish and is never part of the change. A break you ran beats one you traced.\n\n` +
  SKEPTIC_BAR_BLOCK +
  `## Your verdict\n\n` +
  `End your run by calling \`skeptic_verdict\`: it is the last thing you do, and your run ends with it. ` +
  `verdict is "broken" or "holds". For broken, ground is the contract line it breaks, quoted, with the file it ` +
  `is in, or one of: crash, data loss, security, test that cannot fail, false claim; finding is what breaks, the ` +
  `input or case, file:line, and how you showed it. For holds, finding is what you tried. follow_ups lists each ` +
  `thing you found beyond the contract. Do not write the verdict as text.`;

// The finish gates' break-it agents (finish-gates/breakers.ts): the whole app,
// one angle each, after the last chunk landed. Not held to a chunk's contract:
// what they report is graded by severity and fixed or listed.
const FINISH_BREAKER_DISCIPLINE_BLOCK =
  `# Break-it agent\n\n` +
  `An app was just built and says it is finished. Your job is to BREAK IT from the angle your task names. ` +
  `You fix nothing: you cannot edit the project, and \`write\` writes only in \`${SKEPTIC_PROBE_DIR}/\` at the ` +
  `project root, your scratch folder for probe tests, deleted when you finish.\n\n` +
  `- Show each finding, do not assert it: run the tests, run the code with the breaking input, cite file:line. ` +
  `A probe test in \`${SKEPTIC_PROBE_DIR}/\` run with the project's own test runner by its path is the usual way.\n` +
  `- Grade each finding: critical (data loss, a privacy or security hole, a crash on a main path), high (a main ` +
  `flow wrong or a stated rule broken), medium (a real defect off the main path), low (polish).\n` +
  `- Report only what you showed. Nothing found is a valid answer: an empty list.\n\n` +
  `End your run by calling \`breaker_findings\`: it is the last thing you do, and your run ends with it.`;

/** What each role is: the methodology skill it inherits (none for the
 *  skeptic, which builds nothing), its closing discipline, its tools, and its
 *  card. The skeptic gets no write or edit tool: it shows a break, it does not
 *  fix one. */
interface RoleSpec {
  skill: "senior-engineer" | "vibe-code" | null;
  discipline: string;
  agentRole: string;
  tools: readonly string[];
  /** The report this role ends its run with, and so the slot the engine opens for it. */
  report: ReportKind;
  name: string;
  description: string;
  icon: string;
}

/** What a builder starts with: the kit, its report, and tool_search, which
 *  reaches everything else a build worker may hold (buildWorker, below). */
const BUILDER_TOOLS: string[] = [...BUILDER_KIT, "tool_search", "chunk_report"];

const ROLE_SPECS: Record<ChunkAgentRole, RoleSpec> = {
  "chunk-runner-trunk": {
    skill: "senior-engineer", discipline: DISCIPLINE_BLOCK, agentRole: "implementer", tools: BUILDER_TOOLS, report: "chunk",
    name: "Chunk runner (trunk/mixed)", description: "Implements a trunk or mixed chunk from a build plan.", icon: "🏗️",
  },
  "chunk-runner-leaf": {
    skill: "vibe-code", discipline: DISCIPLINE_BLOCK, agentRole: "implementer", tools: BUILDER_TOOLS, report: "chunk",
    name: "Chunk runner (leaf)", description: "Implements a leaf chunk (UI, isolated features) from a build plan.", icon: "🎨",
  },
  "scenario-fix": {
    skill: "senior-engineer", discipline: SCENARIO_FIX_DISCIPLINE_BLOCK, agentRole: "implementer", tools: BUILDER_TOOLS, report: "chunk",
    name: "Scenario fix worker", description: "Fixes phase-gate scenario failures without violating spec/constitution.", icon: "🔧",
  },
  "chunk-skeptic": {
    skill: null, discipline: SKEPTIC_DISCIPLINE_BLOCK, agentRole: "reviewer", tools: [...REVIEW_KIT, "skeptic_verdict"], report: "skeptic",
    name: "Chunk skeptic", description: "Tries to prove a just-built chunk wrong before it counts as done.", icon: "🔍",
  },
  "finish-breaker": {
    skill: null, discipline: FINISH_BREAKER_DISCIPLINE_BLOCK, agentRole: "reviewer", tools: [...REVIEW_KIT, "breaker_findings"], report: "breaker",
    name: "Break-it agent", description: "Attacks a finished app from one angle before the build reports done.", icon: "🧨",
  },
};

/** The brief a role works under, without its skill's methodology: what the
 *  report eval shows a model beside the report tool (eval/worker-report). */
export function chunkRoleBrief(role: ChunkAgentRole): string {
  return ROLE_SPECS[role].discipline;
}

/** What the run delivered, under its role's field of the result. */
function deliveredReport(session: string, kind: ReportKind): Pick<ChunkAgentResult, "chunkReport" | "skepticVerdict" | "breakerFindings"> {
  if (kind === "chunk") { const r = takeReport(session, "chunk"); return r ? { chunkReport: r } : {}; }
  if (kind === "skeptic") { const r = takeReport(session, "skeptic"); return r ? { skepticVerdict: r } : {}; }
  const r = takeReport(session, "breaker");
  return r ? { breakerFindings: r } : {};
}

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
  if (probesOnly(opts.role) && !opts.projectDir) {
    return { stdout: "", exitCode: 1, durationMs: 0, error: `the ${opts.role} needs the project folder it reviews` };
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
    ...(probesOnly(opts.role) ? { writesOnlyUnder: join(opts.projectDir!, SKEPTIC_PROBE_DIR) } : {}),
    // The task (preamble included) is harness prose, not user speech — without
    // this, the instruction ledger reads "Never touch paths outside it" as a
    // user workspace-write ban and every worker write is hard-denied (live
    // failure 2026-07-22: Merchhelm preflight halt).
    harnessAuthoredTask: true,
    // A builder reaches what its build's lead could; a reviewer keeps its kit.
    ...(probesOnly(opts.role) ? {} : { buildWorker: true }),
    ...(opts.priorMessages ? { priorMessages: opts.priorMessages } : {}),
    ...(opts.keepTranscript ? { keepTranscript: true } : {}),
    ...(opts.touches?.length ? { touches: opts.touches } : {}),
  });
  const agentId = ref.runId;
  // The run reports through its tool into a slot keyed by its session, opened
  // here before its first turn (the driver was only started above) and taken
  // in finish(), the one way out: result, silence, deadline or abort.
  const reportsAs = ROLE_SPECS[opts.role].report;
  const reportSession = `agent-${agentId}`;
  openReportSlot(reportSession, reportsAs);

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
      // What the worker started in the background ends with it.
      killSessionsStartedBy(reportSession);
      resolve({ ...result, ...deliveredReport(reportSession, reportsAs) });
    };

    const resultHandler = (data: unknown): void => {
      const d = data as { agentId: string; result?: string; success?: boolean; error?: string; chunk?: string };
      if (d.agentId !== agentId) return;
      if (d.chunk) return; // streaming chunks — wait for the final result
      if (d.success === false) {
        finish({ stdout: d.result || "", exitCode: 1, durationMs: Date.now() - startedAt, error: d.error || d.result || "agent failed" });
      } else {
        const transcript = opts.keepTranscript ? takeRunTranscript(agentId) : undefined;
        finish({ stdout: d.result || "", exitCode: 0, durationMs: Date.now() - startedAt, ...(transcript ? { transcript } : {}) });
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
