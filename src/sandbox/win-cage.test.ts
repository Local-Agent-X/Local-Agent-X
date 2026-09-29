import { describe, expect, it } from "vitest";
import { installExitDetail, parseHelperStatus, underUserProfile, winCageEnvOverlay, winCageHelperDir, winCageLoopbackPermit, wrapForWinCage, WIN_CAGE_HELPER_MAX_PERMIT_WIDTH } from "./win-cage.js";
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
    expect(wrapForWinCage("bash", ["-c", "x"], {}, null)).toEqual({ cmd: "bash", args: ["-c", "x"] });
  });
});
