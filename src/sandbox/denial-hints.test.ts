import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { networkDenialHint, sandboxDenialHint } from "./index.js";
import { installRootDenialHint } from "./denial-hints.js";
import { INSTALL_CHANGE_ROUTE, installRootWriteRule } from "../security/layer/install-root.js";

// networkDenialHint unit tests. The fire-case inputs are the LIVE outputs the
// macOS cage produces (captured via wrapForSeatbelt guarded/strict runs — the
// same denials seatbelt.test.ts asserts on), not invented strings; the
// null-case inputs are the live outputs of the failure modes the hint must
// NOT claim (curl 8.x prints an identical "Couldn't connect to server" for a
// cage EPERM and a genuinely refused port). Platform is passed explicitly so
// the guarded darwin-only gate is deterministic on any CI host.
// sandboxDenialHint's own suite stays in index.test.ts and now doubles as the
// facade-re-export regression pin for the denial-hints.ts split.

const BASH_DEV_TCP_EPERM =
  "/bin/bash: connect: Operation not permitted\n/bin/bash: /dev/tcp/192.0.2.1/80: Operation not permitted\n";
// ≤3.12 traceback format: connect frame immediately followed by the exception.
const PYTHON_CONNECT_EPERM =
  'Traceback (most recent call last):\n  File "<string>", line 1, in <module>\n' +
  '  File ".../socket.py", line 831, in create_connection\n    sock.connect(sa)\n' +
  "PermissionError: [Errno 1] Operation not permitted\n";
// 3.13+ fine-grained-traceback format: marker line between frame and exception.
// Live capture: python 3.14.6 under the guarded seatbelt cage (wrapForSeatbelt),
// `python3 -c 'import socket; socket.create_connection(("192.0.2.1", 80), timeout=5)'`.
const PYTHON314_CONNECT_EPERM =
  'Traceback (most recent call last):\n  File "<string>", line 1, in <module>\n' +
  '    import socket; socket.create_connection(("192.0.2.1", 80), timeout=5)\n' +
  "                   ~~~~~~~~~~~~~~~~~~~~~~~~^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^\n" +
  '  File "/opt/homebrew/Cellar/python@3.14/3.14.6/Frameworks/Python.framework/Versions/3.14/lib/python3.14/socket.py", line 874, in create_connection\n' +
  "    raise exceptions[0]\n" +
  '  File "/opt/homebrew/Cellar/python@3.14/3.14.6/Frameworks/Python.framework/Versions/3.14/lib/python3.14/socket.py", line 859, in create_connection\n' +
  "    sock.connect(sa)\n    ~~~~~~~~~~~~^^^^\n" +
  "PermissionError: [Errno 1] Operation not permitted\n";
// Live capture: node v22.23.1 net.connect under the guarded cage.
const NODE_CONNECT_EPERM =
  "Error: connect EPERM 192.0.2.1:80 - Local (0.0.0.0:0)\n" +
  "    at internalConnect (node:net:1111:16)\n" +
  "    at defaultTriggerAsyncIdScope (node:internal/async_hooks:472:18)\n" +
  "    at node:net:1357:9\n" +
  "    at process.processTicksAndRejections (node:internal/process/task_queues:84:11) {\n" +
  "  errno: -1,\n  code: 'EPERM',\n  syscall: 'connect',\n  address: '192.0.2.1',\n  port: 80\n}\n";
// Live capture: ruby 4.0.5 TCPSocket.new under the guarded cage.
const RUBY_CONNECT_EPERM =
  "-e:1:in 'TCPSocket#initialize': Operation not permitted - connect(2) for \"192.0.2.1\" port 80 (Errno::EPERM)\n" +
  "\tfrom -e:1:in 'IO.new'\n\tfrom -e:1:in '<main>'\n";
// Live capture: ssh under the guarded cage (scp/sftp shell out to ssh too).
const SSH_CONNECT_EPERM = "ssh: connect to host 192.0.2.1 port 22: Operation not permitted\n";
const BASH_DEV_TCP_REFUSED =
  "/bin/bash: connect: Connection refused\n/bin/bash: /dev/tcp/127.0.0.1/1: Connection refused\n";
const CURL_COULDNT_CONNECT =
  "curl: (7) Failed to connect to 192.0.2.1 port 80 after 0 ms: Couldn't connect to server\n";
const BWRAP_NETNS_UNREACH = "/bin/bash: connect: Network is unreachable\n";
const FILE_EPERM_ONLY = "cat: /Users/dad/.aws/credentials: Operation not permitted\n";

describe("networkDenialHint — fire cases", () => {
  it("guarded on darwin: bash /dev/tcp connect-EPERM names the cage, the loopback allowance, and the proxy route", () => {
    const hint = networkDenialHint("guarded", BASH_DEV_TCP_EPERM, "darwin");
    expect(hint).toBeTruthy();
    expect(hint).toContain('mode "guarded"');
    expect(hint).toContain("loopback");
    expect(hint).toMatch(/HTTP_PROXY\/HTTPS_PROXY/);
    expect(hint).toMatch(/egress policy/);
    expect(hint).toMatch(/Settings/);
    expect(hint).toMatch(/LAX_SANDBOX=host/);
    // Truthfulness: the failure must not be pinned on the remote host.
    expect(hint).toMatch(/not the remote host being down/);
  });

  it("guarded on darwin: python socket EPERM (connect frame + next-line PermissionError) fires too", () => {
    expect(networkDenialHint("guarded", PYTHON_CONNECT_EPERM, "darwin")).toContain('mode "guarded"');
  });

  it("python 3.13+ traceback with ~~~^^^ marker line between connect frame and PermissionError fires", () => {
    expect(networkDenialHint("guarded", PYTHON314_CONNECT_EPERM, "darwin")).toContain('mode "guarded"');
  });

  it("node libuv 'connect EPERM <addr>' fires", () => {
    expect(networkDenialHint("guarded", NODE_CONNECT_EPERM, "darwin")).toContain('mode "guarded"');
  });

  it("ruby/C strerror-first 'Operation not permitted - connect(2)' fires", () => {
    expect(networkDenialHint("guarded", RUBY_CONNECT_EPERM, "darwin")).toContain('mode "guarded"');
  });

  it("ssh 'connect to host <h> port <n>: Operation not permitted' fires", () => {
    expect(networkDenialHint("guarded", SSH_CONNECT_EPERM, "darwin")).toContain('mode "guarded"');
  });

  it("strict seatbelt: says ALL network including loopback is denied, and claims no proxy route", () => {
    const hint = networkDenialHint("seatbelt", BASH_DEV_TCP_EPERM, "darwin");
    expect(hint).toBeTruthy();
    expect(hint).toContain('mode "seatbelt"');
    expect(hint).toMatch(/loopback included/);
    expect(hint).toMatch(/No proxy route/);
    // Truthfulness: strict must NOT claim the guarded loopback/proxy allowances.
    expect(hint).not.toMatch(/reach loopback directly/);
    expect(hint).not.toMatch(/HTTP_PROXY/);
  });

  it("strict bwrap: connect-EPERM fires with the netns message (no loopback/proxy claims)", () => {
    const hint = networkDenialHint("bwrap", BASH_DEV_TCP_EPERM, "linux");
    expect(hint).toBeTruthy();
    expect(hint).toContain('mode "bwrap"');
    expect(hint).toMatch(/network namespace/);
    expect(hint).toMatch(/No proxy route/);
    expect(hint).not.toMatch(/reach loopback directly/);
  });

  it("strict bwrap: netns 'Network is unreachable' is the cage's signature and fires", () => {
    expect(networkDenialHint("bwrap", BWRAP_NETNS_UNREACH, "linux")).toContain('mode "bwrap"');
  });
});

describe("networkDenialHint — null cases (never lie)", () => {
  it("returns null in host/docker mode even on connect-EPERM output", () => {
    expect(networkDenialHint("host", BASH_DEV_TCP_EPERM, "darwin")).toBeNull();
    expect(networkDenialHint("docker", BASH_DEV_TCP_EPERM, "linux")).toBeNull();
  });

  // The Windows guarded cage (win-cage.ts) is a firewall fence on a sandbox
  // account. Its refused connect has no live capture behind an anchor here,
  // and neither guarded message describes its reach (loopback only through
  // the proxy's ports), so the hint claims nothing there, whatever the output.
  it("returns null for guarded on Windows — no captured refusal of that cage backs a hint, and neither guarded message describes it", () => {
    expect(networkDenialHint("guarded", BASH_DEV_TCP_EPERM, "win32")).toBeNull();
    expect(networkDenialHint("guarded", NODE_CONNECT_EPERM, "win32")).toBeNull();
    expect(networkDenialHint("guarded", BWRAP_NETNS_UNREACH, "win32")).toBeNull();
  });

  it("guarded on linux: the namespace's 'Network is unreachable' fires, and the message claims only the proxy route", () => {
    const hint = networkDenialHint("guarded", BWRAP_NETNS_UNREACH, "linux");
    expect(hint).toContain('mode "guarded"');
    expect(hint).toMatch(/own network namespace/);
    expect(hint).toMatch(/HTTP_PROXY/);
    expect(hint).toMatch(/registered local services/);
    // The Linux cage does not let loopback through directly; the message must not say it does.
    expect(hint).not.toMatch(/reach loopback directly/);
  });

  it("does NOT blame the cage for 'Connection refused' — that's a live-but-refusing listener", () => {
    expect(networkDenialHint("guarded", BASH_DEV_TCP_REFUSED, "darwin")).toBeNull();
    expect(networkDenialHint("seatbelt", BASH_DEV_TCP_REFUSED, "darwin")).toBeNull();
    expect(networkDenialHint("bwrap", BASH_DEV_TCP_REFUSED, "linux")).toBeNull();
  });

  it("does NOT anchor on curl's ambiguous \"Couldn't connect to server\" (identical for EPERM and refused)", () => {
    expect(networkDenialHint("guarded", CURL_COULDNT_CONNECT, "darwin")).toBeNull();
    expect(networkDenialHint("seatbelt", CURL_COULDNT_CONNECT, "darwin")).toBeNull();
  });

  it("bwrap unreachable anchor needs the connect syscall word, not 'Connection …' prose", () => {
    expect(networkDenialHint("bwrap", "Connection to db failed: Network is unreachable\n", "linux")).toBeNull();
  });

  it("'Network is unreachable' outside bwrap is a real routing problem, not the cage", () => {
    expect(networkDenialHint("guarded", BWRAP_NETNS_UNREACH, "darwin")).toBeNull();
    expect(networkDenialHint("seatbelt", BWRAP_NETNS_UNREACH, "darwin")).toBeNull();
  });

  // Skeptic regression (Aug 2026): the old anchor's `connect(?:ion)?\b` matched
  // at the `.` in `connect.sh`, so a FILE-layer EPERM on a connect-named file
  // fabricated a network-cage message. All rm/chmod/touch lines below are real
  // captured output (uchg-flagged files); they must never fire the network hint.
  it("rm on a uchg connect.sh (absolute and relative) is a FILE denial — never the network cage", () => {
    const abs = "rm: /Users/dad/Projects/lie/connect.sh: Operation not permitted\n";
    expect(networkDenialHint("guarded", abs, "darwin")).toBeNull();
    expect(networkDenialHint("seatbelt", abs, "darwin")).toBeNull();
    expect(networkDenialHint("guarded", "rm: connect.sh: Operation not permitted\n", "darwin")).toBeNull();
  });

  it("a file named exactly 'connect' still cannot forge the shell's `sh: connect:` format", () => {
    expect(networkDenialHint("guarded", "rm: connect: Operation not permitted\n", "darwin")).toBeNull();
    expect(networkDenialHint("seatbelt", "rm: /tmp/lie/connect: Operation not permitted\n", "darwin")).toBeNull();
  });

  it("connection-named files (connection.log, connection-helper.sh) stay null", () => {
    expect(networkDenialHint("guarded", "rm: connection.log: Operation not permitted\n", "darwin")).toBeNull();
    expect(
      networkDenialHint(
        "guarded",
        "chmod: Unable to change file mode on connection-helper.sh: Operation not permitted\n",
        "darwin",
      ),
    ).toBeNull();
    expect(networkDenialHint("guarded", "touch: connect.sh: Operation not permitted\n", "darwin")).toBeNull();
  });

  it("TCC-style prose ('Connection to backup volume failed: Operation not permitted') stays null", () => {
    const prose = "Connection to backup volume failed: Operation not permitted\n";
    expect(networkDenialHint("guarded", prose, "darwin")).toBeNull();
    expect(networkDenialHint("seatbelt", prose, "darwin")).toBeNull();
    expect(networkDenialHint("bwrap", prose, "linux")).toBeNull();
  });

  it("python FILE PermissionError (Errno 1, connect-named file, no .connect( frame) stays null", () => {
    // Live capture: python 3.14.6, open("connect.sh", "w") on a uchg-flagged file.
    const pyFile =
      "Traceback (most recent call last):\n" +
      '  File "<string>", line 1, in <module>\n' +
      '    open("connect.sh", "w")\n' +
      "    ~~~~^^^^^^^^^^^^^^^^^^^\n" +
      "PermissionError: [Errno 1] Operation not permitted: 'connect.sh'\n";
    expect(networkDenialHint("guarded", pyFile, "darwin")).toBeNull();
  });

  it("node anchor is case-sensitive: lowercase 'connect eperm' prose stays null", () => {
    expect(networkDenialHint("guarded", "could not connect eperm happened\n", "darwin")).toBeNull();
  });

  it("a file-only EPERM fires the FILE hint, not the network one", () => {
    expect(networkDenialHint("guarded", FILE_EPERM_ONLY, "darwin")).toBeNull();
    expect(sandboxDenialHint("guarded", FILE_EPERM_ONLY)).toContain("~/.aws");
  });

  it("both hints fire on a combined file+network denial output", () => {
    const combined = FILE_EPERM_ONLY + BASH_DEV_TCP_EPERM;
    expect(sandboxDenialHint("guarded", combined)).toContain("~/.aws");
    expect(networkDenialHint("guarded", combined, "darwin")).toContain("network cage");
  });
});

// The install-root rule (security/layer/install-root.ts): the cage refuses a
// write into the install, config/ included, and the agent must learn the one
// route that is open — self_edit in developer mode — instead of retrying the
// write another way. A synthetic install on this host stands in for the real
// one; the platform argument picks which cage's refusal is expected, so every
// branch runs on any host.
describe("installRootDenialHint — a write the install-root rule refused", () => {
  const base = mkdtempSync(join(tmpdir(), "lax-dh-install-"));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, "install", "workspace"), { recursive: true });
  mkdirSync(join(base, "install", "config"), { recursive: true });
  const rule = installRootWriteRule(join(base, "install"), join(base, "install", "workspace"))!;
  const at = (...parts: string[]) => join(rule.root, ...parts);
  const prompt = at("config", "system-prompt.md");

  it("seatbelt's EPERM on macOS names the file, the rule, config/, and the self_edit route", () => {
    for (const mode of ["guarded", "seatbelt"] as const) {
      const hint = installRootDenialHint(mode, `bash: ${prompt}: Operation not permitted\n`, "darwin", rule);
      expect(hint, mode).toContain(prompt);
      expect(hint).toContain("inside the Local Agent X install folder");
      expect(hint).toContain("config/ included");
      expect(hint).toContain(`The bash kernel cage (mode "${mode}") enforces it at the OS level`);
      expect(hint).toContain(INSTALL_CHANGE_ROUTE);
    }
  });

  it("bwrap's read-only bind on Linux, as bash, touch, rm and python print it", () => {
    for (const out of [
      `bash: ${at("config", "tools.json")}: Read-only file system\n`,
      `touch: cannot touch '${at("config", "tools.json")}': Read-only file system\n`,
      `rm: cannot remove '${at("config", "protected-files.json")}': Read-only file system\n`,
      `OSError: [Errno 30] Read-only file system: '${at("package.json")}'\n`,
    ]) {
      expect(installRootDenialHint("guarded", out, "linux", rule), out).toContain(INSTALL_CHANGE_ROUTE);
      expect(installRootDenialHint("bwrap", out, "linux", rule), out).toContain('mode "bwrap"');
    }
  });

  it("the Windows cage's access denied, as Git Bash, node and PowerShell print it", () => {
    for (const out of [
      `bash: ${prompt}: Permission denied\n`,
      `Error: EPERM: operation not permitted, open '${prompt}'\n`,
      `Access to the path '${prompt}' is denied.\n`,
    ]) {
      const hint = installRootDenialHint("guarded", out, "win32", rule);
      expect(hint, out).toContain("runs as a separate Windows account that is granted the workspace, not the install folder");
      expect(hint).toContain(INSTALL_CHANGE_ROUTE);
    }
  });

  it.skipIf(!/^[a-z]:/i.test(rule.root))("the Windows cage's denial with the path in Git Bash's /c/ form, or another casing", () => {
    const msys = `/${rule.root[0]!.toLowerCase()}${rule.root.slice(2).replace(/\\/g, "/")}/config/tools.json`;
    expect(installRootDenialHint("guarded", `bash: ${msys}: Permission denied\n`, "win32", rule)).toContain(at("config", "tools.json"));
    expect(installRootDenialHint("guarded", `bash: ${at("CONFIG", "tools.json").toUpperCase()}: Permission denied\n`, "win32", rule)).toContain(INSTALL_CHANGE_ROUTE);
    // Git Bash's /backup is a folder of its own, not the drive: a path there
    // that ends in the install's names is not the install.
    expect(installRootDenialHint("guarded", `bash: /backup${msys}: Permission denied\n`, "win32", rule)).toBeNull();
  });

  // The Windows cage cannot read a git clone in the user's profile either, and
  // its refused read reads like a refused write: the notice must send a read
  // to the tools that can make it, not to the user.
  it("the Windows cage's refused read, as Git Bash's cat, ls and grep print it, points at read, grep and glob", () => {
    const shown = (p: string) => (/^[a-z]:/i.test(p) ? `/${p[0]!.toLowerCase()}${p.slice(2).replace(/\\/g, "/")}` : p);
    for (const out of [
      `cat: ${shown(at("package.json"))}: Permission denied\n`,
      `ls: cannot open directory '${shown(at("src"))}': Permission denied\n`,
      `grep: ${shown(prompt)}: Permission denied\n`,
    ]) {
      const hint = installRootDenialHint("guarded", out, "win32", rule);
      expect(hint, out).toContain("refuses its writes, and its reads too");
      expect(hint).toContain("Read files there with the read, grep and glob tools, which do not run in the cage");
      expect(hint).toContain(INSTALL_CHANGE_ROUTE);
    }
  });

  it("the macOS and Linux notices claim no refused read: those cages deny only writes", () => {
    for (const [platform, refusal] of [["darwin", "Operation not permitted"], ["linux", "Read-only file system"]] as const) {
      const hint = installRootDenialHint("guarded", `bash: ${prompt}: ${refusal}\n`, platform, rule);
      expect(hint, platform).toContain(INSTALL_CHANGE_ROUTE);
      expect(hint!.replace(prompt, "")).not.toMatch(/\bread(s|ing)?\b/i);
    }
  });

  it("a path that climbs out of the workspace into the install is the install", () => {
    const climbed = [rule.root, "workspace", "..", "config", "tools.json"].join(sep);
    expect(installRootDenialHint("guarded", `bash: ${climbed}: Operation not permitted\n`, "darwin", rule)).toContain(at("config", "tools.json"));
  });

  it("never fires for the workspace inside the install, a path outside it, or a folder that only shares its names", () => {
    for (const out of [
      `bash: ${at("workspace", "notes.md")}: Operation not permitted\n`,
      `bash: ${join(base, "elsewhere", "config", "tools.json")}: Operation not permitted\n`,
      `bash: ${rule.root}-old${sep}config${sep}tools.json: Operation not permitted\n`,
      `bash: ${join(base, "mirror")}${rule.root.replace(/^[a-z]:/i, "")}${sep}config${sep}tools.json: Operation not permitted\n`,
    ]) {
      expect(installRootDenialHint("guarded", out, "darwin", rule), out).toBeNull();
    }
  });

  it("never fires on a refusal that is not the cage's: a plain EACCES on macOS or Linux is the file's own mode bits", () => {
    expect(installRootDenialHint("guarded", `bash: ${prompt}: Permission denied\n`, "darwin", rule)).toBeNull();
    expect(installRootDenialHint("guarded", `bash: ${prompt}: Permission denied\n`, "linux", rule)).toBeNull();
    expect(installRootDenialHint("guarded", `cat: ${prompt}: No such file or directory\n`, "win32", rule)).toBeNull();
  });

  it("never fires without a cage that enforces the rule on that platform", () => {
    const eperm = `bash: ${prompt}: Operation not permitted\n`;
    expect(installRootDenialHint("host", eperm, "darwin", rule)).toBeNull();
    expect(installRootDenialHint("docker", eperm, "linux", rule)).toBeNull();
    expect(installRootDenialHint("bwrap", eperm, "darwin", rule)).toBeNull();
    expect(installRootDenialHint("seatbelt", `bash: ${prompt}: Permission denied\n`, "win32", rule)).toBeNull();
    expect(installRootDenialHint("guarded", eperm, "freebsd", rule)).toBeNull();
    expect(installRootDenialHint("guarded", eperm, "darwin", null)).toBeNull();
  });

  // The shell tool reads the notice through sandboxDenialHint, on the live
  // install root and this host's cage.
  it("reaches the shell tool through sandboxDenialHint, for the live install's config/", () => {
    const live = installRootWriteRule()!;
    const target = join(live.root, "config", "system-prompt.md");
    const refusal = process.platform === "win32" ? "Permission denied" : process.platform === "linux" ? "Read-only file system" : "Operation not permitted";
    expect(sandboxDenialHint("guarded", `bash: ${target}: ${refusal}\n`)).toContain(INSTALL_CHANGE_ROUTE);
  });
});
