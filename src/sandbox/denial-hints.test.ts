import { describe, it, expect } from "vitest";

import { networkDenialHint, sandboxDenialHint } from "./index.js";

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

  it("returns null for guarded on non-darwin — Linux guarded has NO network cage this campaign", () => {
    expect(networkDenialHint("guarded", BASH_DEV_TCP_EPERM, "linux")).toBeNull();
    expect(networkDenialHint("guarded", BASH_DEV_TCP_EPERM, "win32")).toBeNull();
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
