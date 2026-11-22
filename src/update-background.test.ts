// The background preparation decides whether there is anything to do before it
// builds: an update, out for its quiet period, not prepared already, nothing
// else mutating the install, and not in local-only mode.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = { localOnly: false, lockHeld: false, behind: 3, commitTime: 0, target: "f".repeat(40) };

vi.mock("./local-only-policy.js", () => ({ isLocalOnlyMode: () => state.localOnly }));
vi.mock("./self-edit/global-lock.js", () => ({ isSelfEditLockHeldByLiveProcess: async () => state.lockHeld }));
vi.mock("./git-safety.js", () => ({
  composeGitArgs: (a: string | string[]) => (Array.isArray(a) ? a : a.split(" ")),
  execGit: async (args: string[]) => {
    const cmd = args.join(" ");
    // `behind` commits on origin/main, none of this checkout's own unmatched.
    if (cmd.startsWith("rev-list") && cmd.includes("--right-only")) return Array.from({ length: state.behind }, (_, i) => `${i}`.repeat(40)).join("\n");
    if (cmd.startsWith("rev-list")) return "";
    if (cmd.startsWith("log")) return `${state.target} ${Math.floor(state.commitTime / 1000)}\n`;
    return "";
  },
}));
const prepareGitUpdate = vi.fn();
vi.mock("./update-git-prepare.js", () => ({ prepareGitUpdate: (...a: unknown[]) => prepareGitUpdate(...a), discardGitStaged: vi.fn(async () => {}) }));
vi.mock("./update-rolling.js", () => ({ prepareRollingUpdate: vi.fn(), discardRollingStaged: vi.fn(async () => {}) }));

const { prepareUpdateInBackground, joinPreparation, QUIET_PERIOD_MS } = await import("./update-background.js");
const { readyUpdate, takeReady } = await import("./update-staging.js");
const { updateProgress } = await import("./update-progress.js");

const gate = { ok: true, skipped: false, durationMs: 0, detail: "" };
const staged = () => ({
  route: "git" as const, base: "a".repeat(40), target: state.target, upstream: state.target, preparedAt: 0,
  gates: { deps: gate, build: gate, bind: gate, smoke: gate },
  worktree: "update-x", worktreePath: "/tmp/update-x", branch: "update/x", depsChanged: false, desktopBuilt: false,
});
const NOW = 10 * QUIET_PERIOD_MS;
const now = () => NOW;

beforeEach(() => {
  Object.assign(state, { localOnly: false, lockHeld: false, behind: 3, commitTime: NOW - 2 * QUIET_PERIOD_MS });
  takeReady();
  prepareGitUpdate.mockReset();
  prepareGitUpdate.mockImplementation(async () => ({ ok: true, fromCommit: "a", toCommit: "f", detail: "", staged: staged() }));
});

describe("prepareUpdateInBackground", () => {
  it("prepares the newest update once it has been out for the quiet period, and keeps it ready", async () => {
    expect(await prepareUpdateInBackground("tok", now)).toBe("prepared");
    expect(readyUpdate()?.upstream).toBe(state.target);
    expect(updateProgress(true).mode).toBe("ready");
    expect(await prepareUpdateInBackground("tok", now)).toBe("already-prepared");
    expect(prepareGitUpdate).toHaveBeenCalledTimes(1);
  });

  it("waits out the quiet period after a push, so a burst of pushes is prepared once", async () => {
    state.commitTime = NOW - QUIET_PERIOD_MS / 2;
    expect(await prepareUpdateInBackground("tok", now)).toBe("quiet-period");
    expect(prepareGitUpdate).not.toHaveBeenCalled();
  });

  it("does nothing with no update, in local-only mode, or while another mutation holds the lock", async () => {
    state.behind = 0;
    expect(await prepareUpdateInBackground("tok", now)).toBe("no-update");
    state.behind = 3; state.localOnly = true;
    expect(await prepareUpdateInBackground("tok", now)).toBe("local-only");
    state.localOnly = false; state.lockHeld = true;
    expect(await prepareUpdateInBackground("tok", now)).toBe("lock-held");
    expect(prepareGitUpdate).not.toHaveBeenCalled();
  });

  it("a click joins a preparation in flight instead of starting another, and owns its progress", async () => {
    let finish!: () => void;
    prepareGitUpdate.mockImplementation(() => new Promise((resolve) => { finish = () => resolve({ ok: true, fromCommit: "a", toCommit: "f", detail: "", staged: staged() }); }));
    const pass = prepareUpdateInBackground("tok", now);
    await vi.waitFor(() => expect(prepareGitUpdate).toHaveBeenCalled());
    expect(await prepareUpdateInBackground("tok", now)).toBe("busy");
    const joined = joinPreparation();
    expect(joined).not.toBeNull();
    expect(updateProgress(false).mode).toBe("installing");
    finish();
    await joined;
    expect(await pass).toBe("prepared");
    expect(updateProgress(false).mode).toBe("installing");
  });
});
