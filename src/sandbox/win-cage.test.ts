import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The proof's two process calls — the helper's `status`, and the child node
// that runs both fence probes — answered here, so no helper is needed. With
// `hold` set, a fence probe waits in `held` until the test answers it.
// The provisioning script is spawned, never run: `spawned` keeps its argv.
type ProbeDone = (error: Error | null, stdout: string) => void;
const child = vi.hoisted(() => ({ status: "", probe: "", hold: false, held: [] as Array<(error: Error | null, stdout: string) => void>, scripts: [] as string[], spawned: [] as string[][], exitCode: 0 }));
vi.mock("node:child_process", async (importOriginal) => {
  const { EventEmitter } = await import("node:events");
  return {
    ...(await importOriginal<typeof import("node:child_process")>()),
    execFileSync: () => child.status,
    execFile: (_file: string, args: string[], _opts: unknown, done: ProbeDone) => {
      child.scripts.push(args[1]);
      if (child.hold) child.held.push(done); else done(null, child.probe);
    },
    spawn: (_cmd: string, args: string[]) => {
      child.spawned.push(args);
      const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
      setTimeout(() => proc.emit("exit", child.exitCode), 0);
      return proc;
    },
  };
});

// The range the port owner chose; every test sets it. The proxy's bind is
// captured, not made, so a test can name any range.
const ports = vi.hoisted(() => ({ range: { from: 60090, to: 60099 }, error: null as Error | null, bound: [] as Array<{ from: number; to: number } | undefined> }));
vi.mock("../net/shell-proxy-ports.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../net/shell-proxy-ports.js")>()),
  shellProxyPortRange: async () => { if (ports.error) throw ports.error; return { ...ports.range }; },
}));
vi.mock("../net/egress-proxy-core.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../net/egress-proxy-core.js")>()),
  startEgressProxy: async (options: { ports?: { from: number; to: number } }) => {
    ports.bound.push(options.ports);
    const port = options.ports?.from ?? 0;
    return { url: `http://lax:t@127.0.0.1:${port}`, port, close: async () => {} };
  },
}));

import { _resetWinCageProbe, onWinCageProofSettled, parseHelperStatus, underUserProfile, winCageEnforces, winCageEnforcesSync, winCageEnvOverlay, winCageHelperDir, winCageLoopbackPermit, winCageProbePending, winCageProofView, wrapForWinCage, WIN_CAGE_HELPER_ENV, WIN_CAGE_HELPER_MAX_PERMIT_WIDTH, WIN_CAGE_SANDBOX_USER, WIN_CAGE_SUBLAYER_GUID, type WinCageProof } from "./win-cage.js";
import { installExitDetail, installWinCage, stagedWinCageHelper, uninstallWinCage, winCageInstallView } from "./win-cage-install.js";
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
    vi.stubEnv("ProgramData", "C:\\ProgramData");
    try {
      expect(winCageHelperDir()).toBe("C:\\ProgramData\\Local Agent X\\bin");
    } finally {
      vi.unstubAllEnvs();
    }
    expect(underUserProfile("C:\\Users\\peter\\.lax\\bin\\srt-win.exe", "C:\\Users\\peter")).toBe(true);
    expect(underUserProfile("C:\\Users\\peter", "C:\\Users\\peter")).toBe(true);
    expect(underUserProfile("C:\\Users\\peterson\\srt-win.exe", "C:\\Users\\peter")).toBe(false);
    expect(underUserProfile("C:\\ProgramData\\Local Agent X\\bin\\srt-win.exe", "C:\\Users\\peter")).toBe(false);
  });
});
import { closeShellEgressProxy, currentShellEgressProxyUrl, ensureShellEgressProxy } from "../net/shell-egress-proxy.js";
import { SHELL_PROXY_PORT_CANDIDATES, ShellProxyPortsUnavailableError } from "../net/shell-proxy-ports.js";

// The permit was once compared with the proxy's DEFAULT range, so a run with
// LAX_SHELL_PROXY_PORTS set (needed while Windows reserved the default) read
// a correct permit as wrong. It is held to the range the proxy binds instead.
describe("win-cage — the loopback permit", () => {
  const CHOSEN = [...SHELL_PROXY_PORT_CANDIDATES, { from: 61090, to: 61099 }];
  const prevHelper = process.env[WIN_CAGE_HELPER_ENV];
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lax-cage-helper-"));
    writeFileSync(join(dir, "srt-win.exe"), "");
    process.env[WIN_CAGE_HELPER_ENV] = join(dir, "srt-win.exe");
    ports.error = null;
    ports.bound = [];
    child.spawned = [];
    child.exitCode = 0;
  });
  afterEach(async () => {
    await closeShellEgressProxy();
    if (prevHelper === undefined) delete process.env[WIN_CAGE_HELPER_ENV]; else process.env[WIN_CAGE_HELPER_ENV] = prevHelper;
    rmSync(dir, { recursive: true, force: true });
  });

  it("is the range the proxy binds and the install provisions, whichever range was chosen, within the helper's 50-port cap", async () => {
    for (const range of CHOSEN) {
      ports.range = range;
      await closeShellEgressProxy();
      await ensureShellEgressProxy();
      expect(ports.bound.at(-1)).toEqual(range);
      expect(await winCageLoopbackPermit()).toEqual(range);
      expect((await installWinCage()).ok).toBe(true);
      const argv = child.spawned.at(-1)!;
      expect(argv[argv.indexOf("-PortRange") + 1]).toBe(`${range.from}-${range.to}`);
      expect(range.to - range.from + 1).toBeLessThanOrEqual(WIN_CAGE_HELPER_MAX_PERMIT_WIDTH);
    }
  });

  it("a repair reruns the install over the cage it finds (--force); a plain install does not", async () => {
    ports.range = { from: 47090, to: 47099 };
    await installWinCage();
    expect(child.spawned.at(-1)).not.toContain("-Force");
    await installWinCage({ repair: true });
    const argv = child.spawned.at(-1)!;
    expect(argv).toContain("-Force");
    expect(argv[argv.indexOf("-PortRange") + 1]).toBe("47090-47099");
  });

  it("stops the app's own proxy before provisioning, so its bound port cannot block the reservation", async () => {
    ports.range = { from: 47090, to: 47099 };
    await ensureShellEgressProxy();
    expect(currentShellEgressProxyUrl()).not.toBeNull();
    await installWinCage();
    expect(currentShellEgressProxyUrl()).toBeNull();
  });

  it("a cage installed without its port reservation (exit 15) is installed, and says what is missing", async () => {
    child.exitCode = 15;
    const result = await installWinCage();
    expect(result).toMatchObject({ ok: true, code: 15 });
    expect(result.detail).toMatch(/would not reserve the shell proxy's ports/);
  });

  it("removing the cage from Settings keeps its helper, so it can be installed again", async () => {
    await uninstallWinCage();
    expect(child.spawned.at(-1)).toContain("-Uninstall");
    expect(child.spawned.at(-1)).not.toContain("-RemoveHelper");
  });

  it("no free range installs nothing and says why", async () => {
    ports.error = new ShellProxyPortsUnavailableError(["60090-60099 overlaps the range Windows reserved (60063-60162)"]);
    const result = await installWinCage();
    expect(result).toMatchObject({ ok: false, code: 4 });
    expect(result.detail).toMatch(/No loopback port range is free.*60063-60162/);
    expect(child.spawned).toEqual([]);
  });
});

describe("win-cage — the provisioning script keeps the helper unless the app is uninstalled", () => {
  const provision = () => readFileSync(join(process.cwd(), "scripts", "win-cage", "provision.ps1"), "utf-8");
  it("deletes the helper's folder only under -RemoveHelper, which only the app's uninstaller passes", () => {
    expect(provision()).toMatch(/if \(\$RemoveHelper\) \{ Remove-Item -LiteralPath \$binDir/);
    expect(provision().match(/Remove-Item -LiteralPath \$binDir/g)).toHaveLength(1);
    const uninstaller = readFileSync(join(process.cwd(), "scripts", "uninstall", "lax-uninstall.ps1"), "utf-8");
    expect(uninstaller).toContain("-File $provision -Uninstall -RemoveHelper");
  });

  it("reserves the range only after the helper installed it, releases it on every removal, and records it outside the helper's folder", () => {
    const script = provision();
    expect(script.indexOf("Add-PortReservation $PortRange")).toBeGreaterThan(script.indexOf("& $installed @installArgs"));
    expect(script).toMatch(/Remove-PortReservation\r?\n\s+Write-Output "The cage is removed\."/);
    expect(script).toContain('$reservationFile = Join-Path $env:ProgramData "Local Agent X\\proxy-port-reservation.txt"');
    expect(script).toMatch(/exit 15/);
  });

  it("carries -Force and -RemoveHelper through its own elevation, and -Force to the helper's --force", () => {
    expect(provision()).toContain('if ($Force) { $argv += "-Force" }');
    expect(provision()).toContain('if ($RemoveHelper) { $argv += "-RemoveHelper" }');
    expect(provision()).toContain('if ($Force) { $installArgs += "--force" }');
  });
});

describe("win-cage — what Settings is told beyond the helper's status", () => {
  const prevHelper = process.env[WIN_CAGE_HELPER_ENV];
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lax-cage-view-"));
    vi.stubEnv("ProgramData", dir);
    delete process.env[WIN_CAGE_HELPER_ENV];
    ports.error = null;
    ports.range = { from: 47090, to: 47099 };
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    if (prevHelper === undefined) delete process.env[WIN_CAGE_HELPER_ENV]; else process.env[WIN_CAGE_HELPER_ENV] = prevHelper;
    rmSync(dir, { recursive: true, force: true });
  });

  it("with no helper on the computer, nothing can install, and the user is told to re-run the installer", async () => {
    const view = await winCageInstallView({ helper: null, installed: false, detail: "" });
    expect(view.installable).toBe(false);
    expect(view.detail).toMatch(/Re-run the Local Agent X installer/);
  });

  it("a removed cage's kept helper can install it again", async () => {
    const helper = join(dir, "srt-win.exe");
    writeFileSync(helper, "");
    process.env[WIN_CAGE_HELPER_ENV] = helper;
    expect(await winCageInstallView({ helper, installed: false, detail: "Not installed." })).toEqual({ installable: true });
  });

  it("an installed permit naming another range is a mismatch to repair; the same range, or an unreadable one, is not", async () => {
    const helper = join(dir, "srt-win.exe");
    writeFileSync(helper, "");
    process.env[WIN_CAGE_HELPER_ENV] = helper;
    expect(await winCageInstallView({ helper, installed: true, portRange: "60090-60099", detail: "" }))
      .toEqual({ installable: true, permitMismatch: { installed: "60090-60099", proxy: "47090-47099" } });
    expect(await winCageInstallView({ helper, installed: true, portRange: "47090-47099", detail: "" })).toEqual({ installable: true });
    expect(await winCageInstallView({ helper, installed: true, detail: "" })).toEqual({ installable: true });
  });
});

describe("win-cage — the helper's status, read the way the settings page needs it", () => {
  it("is installed only when the user exists, the credential is stored, and the marker names a SID", () => {
    const fresh = '{"ambient":{"paths":[]},"user":{"ca_cert_pem":null,"cred_present":false,"marker_user_sid":null,"marker_version":null,"real_user_sid":"S-1-5-21-1","user":{"exists":false,"name":"srt-sandbox"}},"wfp":{"filters":0,"state":"cannot-read"}}';
    expect(parseHelperStatus(fresh)).toEqual({ installed: false });
    const ready = '{"user":{"cred_present":true,"marker_user_sid":"S-1-5-21-9-1005","user":{"exists":true,"name":"srt-sandbox"}},"wfp":{"state":"cannot-read","port_range":"60090-60099"}}';
    expect(parseHelperStatus(ready)).toEqual({ installed: true, userSid: "S-1-5-21-9-1005", portRange: "60090-60099" });
    // The helper prints the range as [low, high] when it can read the filters.
    const elevated = '{"user":{"cred_present":true,"marker_user_sid":"S-1-5-21-9-1005","user":{"exists":true}},"wfp":{"state":"installed","port_range":[60090,60099]}}';
    expect(parseHelperStatus(elevated).portRange).toBe("60090-60099");
    // A user without its credential is a half install, not an install.
    expect(parseHelperStatus('{"user":{"cred_present":false,"marker_user_sid":"S-1-5-21-9-1005","user":{"exists":true}}}').installed).toBe(false);
  });

  it("names the helper's install exit codes", () => {
    expect(installExitDetail(0)).toBe("installed");
    expect(installExitDetail(4)).toMatch(/port range/);
    expect(installExitDetail(10)).toMatch(/cancelled/);
    expect(installExitDetail(13)).toMatch(/different port range/);
    expect(installExitDetail(15)).toMatch(/would not reserve/);
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
    child.scripts = [];
    ports.range = { from: 60090, to: 60099 };
    ports.error = null;
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
    await flush(); // the probe starts once the port range is in hand
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

  it("proves loopback inside the range the proxy binds", async () => {
    ports.range = { from: 47090, to: 47099 };
    child.probe = PROVEN;
    expect(await winCageEnforces()).toBe(true);
    expect(child.scripts.at(-1)).toContain("for (let p = 47090; p <= 47099 ");
  });

  it("an installed permit naming another range fails the proof with both ranges, before any probe", async () => {
    ports.range = { from: 47090, to: 47099 };
    child.status = JSON.stringify({ user: { cred_present: true, marker_user_sid: "S-1-5-21-9-1005", user: { exists: true } }, wfp: { port_range: "60090-60099" } });
    expect(await winCageEnforces()).toBe(false);
    expect(child.scripts).toEqual([]);
    expect(winCageProofView().proofFailure).toMatch(/permits loopback ports 60090-60099 but the shell egress proxy binds 47090-47099/);
  });

  it("no free range fails the proof with the reason the settings page shows", async () => {
    ports.error = new ShellProxyPortsUnavailableError(["47090-47099 has no port that binds"]);
    expect(await winCageEnforces()).toBe(false);
    expect(child.scripts).toEqual([]);
    expect(winCageProofView().proofFailure).toMatch(/No loopback port range is free.*47090-47099 has no port that binds/);
  });

  it("an awaited proof follows a reset to the proof that replaced it", async () => {
    child.hold = true;
    const answer = winCageEnforces();
    _resetWinCageProbe();
    winCageEnforcesSync();
    await flush(); // the probe starts once the port range is in hand
    const [before, after] = child.held;
    before(null, OPEN);
    await flush();
    after(null, PROVEN);
    expect(await answer).toBe(true);
  });
});
