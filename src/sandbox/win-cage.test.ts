import { describe, expect, it } from "vitest";
import { installExitDetail, parseHelperStatus, winCageEnvOverlay, wrapForWinCage, WIN_CAGE_LOOPBACK_PERMIT } from "./win-cage.js";
import { SHELL_PROXY_PORTS_DEFAULT } from "../net/shell-egress-proxy.js";

describe("win-cage — loopback is open inside the fence", () => {
  it("the permit covers every loopback port, the proxy's range included", () => {
    expect(WIN_CAGE_LOOPBACK_PERMIT).toEqual({ from: 1, to: 65535 });
    expect(SHELL_PROXY_PORTS_DEFAULT.from).toBeGreaterThanOrEqual(WIN_CAGE_LOOPBACK_PERMIT.from);
    expect(SHELL_PROXY_PORTS_DEFAULT.to).toBeLessThanOrEqual(WIN_CAGE_LOOPBACK_PERMIT.to);
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
