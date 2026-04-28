/**
 * Autopilot Mode types.
 *
 * Autopilot is a session-long autonomous work mode. The user names a topic and
 * a duration; the agent works inside an isolated git worktree, validating and
 * committing each round only when build passes. Rounds with no diff or failed
 * validation are reverted via `git reset --hard HEAD && git clean -fd`.
 *
 * Key concept: rounds are NOT phases. We reuse the Operation type for
 * persistence/events/status only — autopilot has its own loop, not the
 * conductor's phase machine.
 */

export interface AutopilotConfig {
  /** User's intent string. Shown in nudges and commit messages. */
  topic: string;
  /** File-path or glob hints. NOT enforced; surfaced in summary. */
  scope: string[];
  /** Total time budget in ms. Default 30 min. */
  durationMs: number;
  /** Hard cap on rounds before stop. Default 20. */
  maxRounds: number;
  /** Stop after this many no-op rounds in a row. Default 2. */
  maxNoopRounds: number;
  /** self_edit invocation ceiling. Default 5. */
  maxSelfEditCalls: number;
  /** If true, run the test command in addition to build. Default false. */
  withTests: boolean;
  /** Worktree path on disk, set by start.ts. */
  worktreePath: string;
  /** Worktree map key (used for getWorktreeStatus / commitInWorktree etc). */
  worktreeName: string;
  /** Branch name, set by start.ts (autopilot/<slug>/<ts>). */
  branchName: string;
  /** Branch we'll merge back to (captured at creation). */
  baseBranch: string;
  /** Build command override; null = skip build gate. */
  buildCommand: string | null;
  /** Build timeout in ms. */
  buildTimeoutMs: number;
  /** Test command (only used if withTests=true). */
  testCommand: string;
  /** Test timeout in ms. */
  testTimeoutMs: number;
  /** Per-file LOC limit for delta check. Default 400. */
  fileSizeLimit: number;
}

export type RoundOutcome = "passed" | "noop" | "failed-build" | "failed-size" | "failed-test" | "agent-error";

export interface RoundResult {
  /** 1-indexed round number. */
  round: number;
  outcome: RoundOutcome;
  /** Agent's one-line summary (extracted from final message), or error. */
  summary: string;
  /** Files touched this round (from git diff). */
  filesChanged: string[];
  /** Of filesChanged, which are inside the user-declared scope. */
  filesInScope: string[];
  /** Of filesChanged, which are outside the user-declared scope. */
  filesOutOfScope: string[];
  /** Commit SHA if the round committed; null otherwise. */
  commitSha: string | null;
  /** Wall-clock ms for the round. */
  durationMs: number;
  /** ISO timestamp when round started. */
  startedAt: string;
}

export type AutopilotState =
  | "running"
  | "completed"        // agent emitted AUTOPILOT_DONE
  | "deadline"         // time budget exhausted
  | "max-rounds"       // hit maxRounds cap
  | "no-progress"      // hit maxNoopRounds in a row
  | "interrupted"      // user POST /api/autopilot/stop
  | "error";           // unrecoverable error

export interface AutopilotRunSummary {
  opId: string;
  state: AutopilotState;
  topic: string;
  scope: string[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  totalRounds: number;
  passedRounds: number;
  noopRounds: number;
  failedRounds: number;
  selfEditCalls: number;
  branchName: string;
  baseBranch: string;
  /** Aggregated across all passed rounds. */
  filesChangedInScope: string[];
  filesChangedOutOfScope: string[];
  /** Final build status from the most recent passed round. */
  buildStatus: "passing" | "failing" | "skipped";
  /** Per-round detail, in order. */
  rounds: RoundResult[];
}

/** Request payload for POST /api/autopilot/start. */
export interface StartAutopilotRequest {
  topic: string;
  scope: string[];
  durationMs?: number;
  maxRounds?: number;
  maxNoopRounds?: number;
  maxSelfEditCalls?: number;
  withTests?: boolean;
}

/** Lock file contents at ~/.lax/autopilot/<repo-hash>.lock */
export interface AutopilotLockFile {
  pid: number;
  opId: string;
  topic: string;
  startedAt: string;
}
