// Host mode was a state the agent fell into silently: when the chosen cage is
// unusable, attended shell runs unconfined with a Settings badge and nothing
// in the chat (red team round 2, I-H2). The call still runs — refusing it
// would stop real work on every dev box for a one-time click — but the first
// attended shell call in a session now carries a notice, and only the first.
import { beforeEach, describe, expect, it } from "vitest";
import type { SandboxStatus } from "../sandbox/index.js";
import { _resetHostFallbackNoticesForTests, attendedHostFallbackNotice } from "./unattended-shell-gate.js";

const status = (over: Partial<SandboxStatus>): SandboxStatus => ({
  selectedMode: "guarded", effectiveMode: "host", confined: false,
  fallbackReason: "The guarded kernel cage is unavailable on this host, so bash is unconfined.",
  proofPending: false, unconfinedHostAcknowledged: false, delegatedShellAllowed: false, apiShellAllowed: false,
  ...over,
});

beforeEach(() => _resetHostFallbackNoticesForTests());

describe("an attended shell call on a host the cage fell back from", () => {
  it("carries the reason once per session, and runs", () => {
    const first = attendedHostFallbackNotice("s1", "bash", "local", status({}));
    expect(first).toMatch(/UNCONFINED/);
    expect(first).toContain("guarded kernel cage is unavailable");
    expect(first).toContain("Settings > Security");
    expect(attendedHostFallbackNotice("s1", "process_start", "local", status({}))).toBeNull();
    expect(attendedHostFallbackNotice("s2", "bash", "local", status({}))).not.toBeNull();
  });

  it("says nothing when the cage holds, when the user chose or acknowledged the host, or while a cage proves itself", () => {
    expect(attendedHostFallbackNotice("s1", "bash", "local", status({ effectiveMode: "guarded", confined: true, fallbackReason: undefined }))).toBeNull();
    expect(attendedHostFallbackNotice("s2", "bash", "local", status({ selectedMode: "host", fallbackReason: undefined }))).toBeNull();
    expect(attendedHostFallbackNotice("s3", "bash", "local", status({ unconfinedHostAcknowledged: true }))).toBeNull();
    expect(attendedHostFallbackNotice("s4", "bash", "local", status({ proofPending: true }))).toBeNull();
  });

  it("is not for non-shell tools, nor for unattended runs, which the gate refuses or parks instead", () => {
    expect(attendedHostFallbackNotice("s1", "read", "local", status({}))).toBeNull();
    expect(attendedHostFallbackNotice("s1", "bash", "delegated", status({}))).toBeNull();
    expect(attendedHostFallbackNotice("s1", "bash", "cron", status({}))).toBeNull();
  });
});
