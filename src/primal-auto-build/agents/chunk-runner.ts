/**
 * Chunk worker invocation via the canonical agent path.
 *
 * Builds an ad-hoc AgentDefinition with the relevant skill methodology +
 * chunk-runner discipline baked into systemPrompt, dispatches it through
 * invokeDefinition (Handler → adapter), awaits completion via the
 * "handler:agent-result" EventBus event.
 *
 * Two roles exposed:
 *   - "chunk-runner-trunk" — /senior-engineer methodology, for trunk + mixed
 *   - "chunk-runner-leaf"  — /vibe-code methodology, for leaf
 *   - "scenario-fix"       — /senior-engineer + scenario-fix constraints
 *
 * The systemPrompt is computed at first invocation per role and cached.
 * Skill body comes from `protocols/bundled/<name>/SKILL.md` (the same
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
import { loadSkillBody } from "../skill-bodies.js";

export type ChunkAgentRole = "chunk-runner-trunk" | "chunk-runner-leaf" | "scenario-fix";

export interface ChunkAgentInvocation {
  role: ChunkAgentRole;
  /** The chunk-specific task body (slice, done-when, retry framing, etc).
   *  System prompt + discipline lives in the AgentDefinition. */
  task: string;
  /** Absolute path to the PROJECT directory the agent works in.
   *  Without this, the agent runs from the LAX repo root and can't
   *  find the project's app/ tree. (Live failure 2026-05-12: chunk
   *  blocked with "apps/ missing" because the worker looked for
   *  monorepo structure inside the LAX repo, not the project.) */
  projectDir?: string;
  /** Originating chat session — propagated for sidebar attribution. */
  parentSessionId?: string;
  /** Wall-clock kill deadline. Default: 30 min per chunk. */
  timeoutMs?: number;
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

const DEFAULT_TIMEOUT_MS = 30 * 60_000;

const DISCIPLINE_BLOCK =
  `## Discipline (load-bearing — do not skip)\n\n` +
  `- **You are a non-interactive worker.** No human is watching. Don't pause to ask, ` +
  `don't request a planning conversation, don't wait for confirmation. If you'd normally ` +
  `ask the user, surface it in the final report's NOTE field and ship the safest available choice.\n` +
  `- **Read \`spec/\` only.** Do not read \`scenarios/\` or \`twins/\`. Those are the held-out ` +
  `test set; reading them is teaching-to-the-test and invalidates the build.\n` +
  `- **Code matches spec, never the reverse.** If the spec is unclear, STOP and surface the ` +
  `ambiguity in your final report. Do not weaken done-when to fit your implementation.\n` +
  `- **Minimum change.** Implement what the assigned task requires. No refactoring of neighbors, ` +
  `no unrelated abstractions.\n` +
  `- **Run the tests.** If done-when names tests, those tests must pass before you report done. ` +
  `Don't mark deferred verifications as done — name them explicitly in NOTE so the reviewer can ` +
  `route to launch-readiness.\n` +
  `- **Don't touch \`spec/\`.** Spec amendments are the reviewer's job. Surface gaps in NOTE.\n\n` +
  `## Report format (the review pass parses this — keep it exact)\n\n` +
  `When you finish, reply with EXACTLY this block (no other text after it):\n\n` +
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

const SKILL_FOR_ROLE: Record<ChunkAgentRole, "senior-engineer" | "vibe-code"> = {
  "chunk-runner-trunk": "senior-engineer",
  "chunk-runner-leaf": "vibe-code",
  "scenario-fix": "senior-engineer",
};

const DEF_CACHE = new Map<ChunkAgentRole, AgentDefinition>();

function getDefinition(role: ChunkAgentRole): AgentDefinition {
  const cached = DEF_CACHE.get(role);
  if (cached) return cached;

  const skill = SKILL_FOR_ROLE[role];
  const skillBody = loadSkillBody(skill);
  const isFix = role === "scenario-fix";

  const systemPrompt =
    `# Worker methodology — /${skill}\n\n` +
    `Load-bearing methodology this worker inherits. Read it before touching code; ` +
    `it's the discipline the review pass enforces against.\n\n` +
    `---\n\n${skillBody}\n\n---\n\n` +
    (isFix ? SCENARIO_FIX_DISCIPLINE_BLOCK : DISCIPLINE_BLOCK);

  const def: AgentDefinition = {
    id: `builtin-${role}`,
    name: role === "scenario-fix" ? "Scenario fix worker" :
          role === "chunk-runner-leaf" ? "Chunk runner (leaf)" :
          "Chunk runner (trunk/mixed)",
    role: "implementer",
    systemPrompt,
    allowedTools: ["read", "write", "edit", "glob", "grep", "bash"],
    description:
      role === "scenario-fix"
        ? "Fixes phase-gate scenario failures without violating spec/constitution."
        : role === "chunk-runner-leaf"
        ? "Implements a leaf chunk (UI, isolated features) from a build plan."
        : "Implements a trunk or mixed chunk from a build plan.",
    icon: role === "scenario-fix" ? "🔧" : role === "chunk-runner-leaf" ? "🎨" : "🏗️",
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
  const def = getDefinition(opts.role);
  const startedAt = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Prepend a working-directory anchor so the agent doesn't look for
  // the project tree inside the LAX repo root. This is load-bearing —
  // without it, the agent's `bash`/`read`/`glob` calls run from wherever
  // the server was started (LAX repo) and it can't find the project.
  const taskWithCwd = opts.projectDir
    ? `## Working directory\n\n` +
      `Your project root is: \`${opts.projectDir}\`\n\n` +
      `**ALL file paths in this chunk are relative to that directory.** Before reading, ` +
      `globbing, or running bash, \`cd\` there. The plan file, spec/, scenarios/, source ` +
      `files, and tests all live under that root. Don't look for them in the LAX repo.\n\n` +
      `---\n\n${opts.task}`
    : opts.task;

  const ref = invokeDefinition(def, taskWithCwd, {
    parentSessionId: opts.parentSessionId,
  });
  const agentId = ref.fieldAgentId;

  return await new Promise<ChunkAgentResult>((resolve) => {
    let settled = false;
    const finish = (result: ChunkAgentResult) => {
      if (settled) return;
      settled = true;
      EventBus.off("handler:agent-result", resultHandler);
      EventBus.off("handler:agent-error", errorHandler);
      EventBus.off("handler:agent-done", doneHandler);
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abortListener);
      resolve(result);
    };

    const resultHandler = (data: unknown): void => {
      const d = data as { agentId: string; result?: string; error?: string; chunk?: string };
      if (d.agentId !== agentId) return;
      if (d.chunk) return; // streaming chunks — wait for the final result
      if (d.error) {
        finish({ stdout: d.result || "", exitCode: 1, durationMs: Date.now() - startedAt, error: d.error });
      } else {
        finish({ stdout: d.result || "", exitCode: 0, durationMs: Date.now() - startedAt });
      }
    };
    const errorHandler = (data: unknown): void => {
      const d = data as { agentId: string; error: string };
      if (d.agentId !== agentId) return;
      finish({ stdout: "", exitCode: 1, durationMs: Date.now() - startedAt, error: d.error });
    };
    const doneHandler = (data: unknown): void => {
      const d = data as { agentId: string; result?: string };
      if (d.agentId !== agentId) return;
      finish({ stdout: d.result || "", exitCode: 0, durationMs: Date.now() - startedAt });
    };

    EventBus.on("handler:agent-result", resultHandler);
    EventBus.on("handler:agent-error", errorHandler);
    EventBus.on("handler:agent-done", doneHandler);

    const timer = setTimeout(() => {
      finish({ stdout: "", exitCode: 124, durationMs: Date.now() - startedAt, error: `chunk agent timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    const abortListener = () => {
      finish({ stdout: "", exitCode: 130, durationMs: Date.now() - startedAt, error: "aborted by caller" });
    };
    if (opts.signal) {
      if (opts.signal.aborted) abortListener();
      else opts.signal.addEventListener("abort", abortListener, { once: true });
    }
  });
}

/** Test-only helper to inspect/reset the definition cache. */
export function _clearChunkAgentDefCache(): void { DEF_CACHE.clear(); }
