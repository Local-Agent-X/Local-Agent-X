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
const PYTHON_CONNECT_EPERM =
  'Traceback (most recent call last):\n  File "<string>", line 1, in <module>\n' +
  '  File ".../socket.py", line 831, in create_connection\n    sock.connect(sa)\n' +
  "PermissionError: [Errno 1] Operation not permitted\n";
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

  it("'Network is unreachable' outside bwrap is a real routing problem, not the cage", () => {
    expect(networkDenialHint("guarded", BWRAP_NETNS_UNREACH, "darwin")).toBeNull();
    expect(networkDenialHint("seatbelt", BWRAP_NETNS_UNREACH, "darwin")).toBeNull();
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
