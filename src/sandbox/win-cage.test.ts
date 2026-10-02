import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The proof's two process calls — the helper's `status`, and the child node
// that runs both fence probes — answered here, so no helper is needed. With
// `hold` set, a fence probe waits in `held` until the test answers it.
type ProbeDone = (error: Error | null, stdout: string) => void;
const child = vi.hoisted(() => ({ status: "", probe: "", hold: false, held: [] as Array<(error: Error | null, stdout: string) => void> }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: () => child.status,
  execFile: (_file: string, _args: string[], _opts: unknown, done: ProbeDone) => { if (child.hold) child.held.push(done); else done(null, child.probe); },
}));

import { _resetWinCageProbe, onWinCageProofSettled, parseHelperStatus, underUserProfile, winCageEnforces, winCageEnforcesSync, winCageEnvOverlay, winCageHelperDir, winCageLoopbackPermit, winCageProbePending, winCageProofView, wrapForWinCage, WIN_CAGE_HELPER_ENV, WIN_CAGE_HELPER_MAX_PERMIT_WIDTH, WIN_CAGE_SANDBOX_USER, WIN_CAGE_SUBLAYER_GUID, type WinCageProof } from "./win-cage.js";
import { installExitDetail, stagedWinCageHelper } from "./win-cage-install.js";
import { winCageReadGrants } from "./win-cage-grants.js";

describe("win-cage — what the caged shell is granted to read", () => {
  it("the shell's install root, the node folder and the app's code when they sit under the profile, deduplicated", () => {
    const home = "C:\\Users\\peter";
    const grants = winCageReadGrants(
      "C:\\Users\\peter\\AppData\\Local\\LocalAgentX\\PortableGit\\bin\\bash.exe",
      "C:\\Users\\peter\\AppData\\Local\\LocalAgentX\\node-v24.16.0-win-x64\\node.exe",
      "C:\\Users\\peter\\local-agent-x",
      home,
    );
    // The app's own code is deliberately not granted (its node_modules is the
    // slowest tree to stamp and the cage does not need it).
    expect(grants).toEqual([
      "C:\\Users\\peter\\AppData\\Local\\LocalAgentX\\PortableGit",
      "C:\\Users\\peter\\AppData\\Local\\LocalAgentX\\node-v24.16.0-win-x64",
    ]);
  });

  it("grants nothing for machine-wide tools, and a root covers its subpaths", () => {
    const home = "C:\\Users\\peter";
    expect(winCageReadGrants("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "C:\\Program Files\\nodejs\\node.exe", "C:\\ProgramData\\Local Agent X", home)).toEqual([]);
    expect(winCageReadGrants("C:\\Users\\peter\\app\\git\\bin\\bash.exe", "C:\\Users\\peter\\app\\git\\node\\node.exe", "C:\\Users\\peter\\app", home)).toEqual([
      "C:\\Users\\peter\\app\\git",
    ]);
  });
});

describe("win-cage — the app and the provisioning script name the same cage", () => {
  it("sublayer GUID and sandbox account match scripts/win-cage/provision.ps1", () => {
    const script = readFileSync(join(process.cwd(), "scripts", "win-cage", "provision.ps1"), "utf-8");
    expect(script).toContain(`$SublayerGuid = "${WIN_CAGE_SUBLAYER_GUID}"`);
    expect(script).toContain(`$SandboxUser = "${WIN_CAGE_SANDBOX_USER}"`);
  });

  it("the staged helper is the installer's copy under the install root, or nothing", () => {
    expect(stagedWinCageHelper("C:\\definitely\\not\\here")).toBeNull();
  });
});

describe("win-cage — where the helper may live", () => {
  it("the expected folder is machine-wide, and a profile path is recognised as one the sandbox user cannot read", () => {
    expect(winCageHelperDir().toLowerCase()).not.toContain("\\users\\");
    expect(underUserProfile("C:\\Users\\peter\\.lax\\bin\\srt-win.exe", "C:\\Users\\peter")).toBe(true);
    expect(underUserProfile("C:\\Users\\peter", "C:\\Users\\peter")).toBe(true);
    expect(underUserProfile("C:\\Users\\peterson\\srt-win.exe", "C:\\Users\\peter")).toBe(false);
    expect(underUserProfile("C:\\ProgramData\\Local Agent X\\bin\\srt-win.exe", "C:\\Users\\peter")).toBe(false);
  });
});
import { SHELL_PROXY_PORTS_DEFAULT } from "../net/shell-egress-proxy.js";

describe("win-cage — the loopback permit", () => {
  it("covers the proxy's range and fits the upstream helper's 50-port cap (open loopback waits for LAX's own helper build)", () => {
    const permit = winCageLoopbackPermit();
    expect(permit.from).toBeLessThanOrEqual(SHELL_PROXY_PORTS_DEFAULT.from);
    expect(permit.to).toBeGreaterThanOrEqual(SHELL_PROXY_PORTS_DEFAULT.to);
    expect(permit.to - permit.from + 1).toBeLessThanOrEqual(WIN_CAGE_HELPER_MAX_PERMIT_WIDTH);
  });
});

describe("win-cage — the helper's status, read the way the settings page needs it", () => {
  it("is installed only when the user exists, the credential is stored, and the marker names a SID", () => {
    const fresh = '{"ambient":{"paths":[]},"user":{"ca_cert_pem":null,"cred_present":false,"marker_user_sid":null,"marker_version":null,"real_user_sid":"S-1-5-21-1","user":{"exists":false,"name":"srt-sandbox"}},"wfp":{"filters":0,"state":"cannot-read"}}';
    expect(parseHelperStatus(fresh)).toEqual({ installed: false });
    const ready = '{"user":{"cred_present":true,"marker_user_sid":"S-1-5-21-9-1005","user":{"exists":true,"name":"srt-sandbox"}},"wfp":{"state":"cannot-read","port_range":"60090-60099"}}';
    expect(parseHelperStatus(ready)).toEqual({ installed: true, userSid: "S-1-5-21-9-1005", portRange: "60090-60099" });
    // A user without its credential is a half install, not an install.
    expect(parseHelperStatus('{"user":{"cred_present":false,"marker_user_sid":"S-1-5-21-9-1005","user":{"exists":true}}}').installed).toBe(false);
  });

  it("names the helper's install exit codes", () => {
    expect(installExitDetail(0)).toBe("installed");
    expect(installExitDetail(10)).toMatch(/cancelled/);
    expect(installExitDetail(13)).toMatch(/different port range/);
    expect(installExitDetail(99)).toMatch(/code 99/);
  });
});

describe("win-cage — the child's environment", () => {
  it("passes the shell env through except the real user's profile, and drops empties", () => {
    const overlay = winCageEnvOverlay({
      PATH: "C:\\Program Files\\Git\\bin;C:\\Windows", SYSTEMROOT: "C:\\Windows", HTTP_PROXY: "http://lax:t@127.0.0.1:60090",
      NODE_USE_ENV_PROXY: "1", GIT_TERMINAL_PROMPT: "0",
      USERPROFILE: "C:\\Users\\peter", APPDATA: "C:\\Users\\peter\\AppData\\Roaming", LOCALAPPDATA: "x", TEMP: "x", TMP: "x", HOME: "x", USERNAME: "peter",
      EMPTY: "",
    });
    expect(overlay).toEqual([
      "PATH=C:\\Program Files\\Git\\bin;C:\\Windows", "SYSTEMROOT=C:\\Windows", "HTTP_PROXY=http://lax:t@127.0.0.1:60090",
      "NODE_USE_ENV_PROXY=1", "GIT_TERMINAL_PROMPT=0",
    ]);
  });

  it("wraps the shell as an exec through the helper with the overlay, and passes through without a helper", () => {
    const wrapped = wrapForWinCage("C:\\Program Files\\Git\\bin\\bash.exe", ["-c", "echo hi"], { PATH: "C:\\Windows", USERPROFILE: "C:\\Users\\peter" }, "C:\\lax\\bin\\srt-win.exe");
    expect(wrapped.cmd).toBe("C:\\lax\\bin\\srt-win.exe");
    expect(wrapped.args).toEqual(["exec", "--quiet", "--env", "PATH=C:\\Windows", "--", "C:\\Program Files\\Git\\bin\\bash.exe", "-c", "echo hi"]);
  });
});

// The server re-broadcasts the sandbox status from this listener: it is what
// moves a Settings page opened while the proof ran off its "checking" state.
describe("win-cage — the fence proof's lifecycle", () => {
  const realPlatform = process.platform;
  const prevHelper = process.env[WIN_CAGE_HELPER_ENV];
  const prevProgramData = process.env.ProgramData;
  const INSTALLED = JSON.stringify({ user: { cred_present: true, marker_user_sid: "S-1-5-21-9-1005", user: { exists: true } } });
  const PROVEN = JSON.stringify({ offBox: "blocked", loopback: "reached" });
  const OPEN = JSON.stringify({ offBox: "unreachable", loopback: "reached" });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lax-cage-helper-"));
    writeFileSync(join(dir, "srt-win.exe"), "");
    process.env[WIN_CAGE_HELPER_ENV] = join(dir, "srt-win.exe");
    Object.defineProperty(process, "platform", { value: "win32" });
    child.status = INSTALLED;
    child.hold = false;
    child.held = [];
    _resetWinCageProbe();
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform });
    if (prevHelper === undefined) delete process.env[WIN_CAGE_HELPER_ENV]; else process.env[WIN_CAGE_HELPER_ENV] = prevHelper;
    if (prevProgramData === undefined) delete process.env.ProgramData; else process.env.ProgramData = prevProgramData;
    rmSync(dir, { recursive: true, force: true });
    _resetWinCageProbe();
  });

  it("fires once for a proven fence and once for an open one, after the proof stops pending", async () => {
    const heard: Array<{ proof: WinCageProof; pendingThen: boolean }> = [];
    onWinCageProofSettled((proof) => heard.push({ proof, pendingThen: winCageProbePending() }));

    child.probe = PROVEN;
    expect(winCageEnforcesSync()).toBe(false);
    expect(winCageProofView()).toEqual({ proofPending: true });
    expect(await winCageEnforces()).toBe(true);
    expect(heard).toEqual([{ proof: { ok: true, installed: true, reason: "" }, pendingThen: false }]);
    expect(winCageProofView()).toEqual({ proofPending: false });

    _resetWinCageProbe();
    child.probe = OPEN;
    expect(await winCageEnforces()).toBe(false);
    expect(heard).toHaveLength(2);
    expect(heard[1]).toMatchObject({ proof: { ok: false, installed: true }, pendingThen: false });
    expect(heard[1].proof.reason).toMatch(/fence is not active.*unreachable/);
    expect(winCageProofView()).toEqual({ proofPending: false, proofFailure: heard[1].proof.reason });
  });

  // A machine without the cage has nothing to verify. Reading as "being
  // verified" there would hold every shell for a proof that can only fail and
  // refuse the synchronous starts (dev servers) outright.
  it("settles at once, never pending, when the helper is missing or the cage is not installed", () => {
    const heard: WinCageProof[] = [];
    onWinCageProofSettled((proof) => heard.push(proof));

    delete process.env[WIN_CAGE_HELPER_ENV];
    process.env.ProgramData = dir;
    expect(winCageEnforcesSync()).toBe(false);
    expect(winCageProbePending()).toBe(false);
    expect(winCageProofView()).toEqual({ proofPending: false });
    expect(winCageEnforcesSync()).toBe(false);
    expect(winCageProbePending()).toBe(false);

    _resetWinCageProbe();
    process.env[WIN_CAGE_HELPER_ENV] = join(dir, "srt-win.exe");
    child.status = JSON.stringify({ user: { cred_present: false, user: { exists: false } } });
    expect(winCageEnforcesSync()).toBe(false);
    expect(winCageProbePending()).toBe(false);
    // Not installed is not "installed but broken": the page offers the install.
    expect(winCageProofView()).toEqual({ proofPending: false });
    expect(heard).toEqual([]);
  });

  // Install and uninstall forget the proof while one may be running; the old
  // probe's answer is about the cage as it was.
  it("a proof started before a reset never overwrites the one started after it", async () => {
    const heard: WinCageProof[] = [];
    onWinCageProofSettled((proof) => heard.push(proof));
    child.hold = true;

    winCageEnforcesSync();
    _resetWinCageProbe();
    winCageEnforcesSync();
    const [before, after] = child.held;
    expect(child.held).toHaveLength(2);

    before(null, PROVEN);
    await flush();
    expect(winCageProbePending()).toBe(true);
    expect(winCageProofView()).toEqual({ proofPending: true });
    expect(heard).toEqual([]);

    after(null, OPEN);
    expect(await winCageEnforces()).toBe(false);
    expect(winCageProbePending()).toBe(false);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ ok: false, installed: true });
  });

  it("an awaited proof follows a reset to the proof that replaced it", async () => {
    child.hold = true;
    const answer = winCageEnforces();
    _resetWinCageProbe();
    winCageEnforcesSync();
    const [before, after] = child.held;
    before(null, OPEN);
    await flush();
    after(null, PROVEN);
    expect(await answer).toBe(true);
  });
});
