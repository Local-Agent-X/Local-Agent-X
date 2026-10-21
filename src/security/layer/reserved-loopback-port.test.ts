// The in-app browser's CDP endpoint (native driving) is a loopback port with
// no credential that drives every signed-in view. reservedLoopbackPorts() is
// the one derivation that withholds it, but two "every loopback port" switches
// and the browser URL gate decided before consulting it, and the port rode
// into every shell child in its env (red team round 2, B-H1/B-H3/B-M4).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let localOnly = false;
let disposable = false;
vi.mock("../../local-only-policy.js", async (orig) => ({ ...(await orig<object>()), isLocalOnlyMode: () => localOnly }));
vi.mock("./disposable-sandbox.js", async (orig) => ({ ...(await orig<object>()), isDisposableSandbox: () => disposable }));

import { evaluateWebFetch } from "./network-policy.js";
import { loopbackServiceReachable, shellLoopbackReachable } from "./loopback-grant.js";
import { evaluateBrowserUrl } from "./browser-egress-eval.js";
import { reservedLoopbackPorts } from "./security-config.js";
import { buildSanitizedEnv } from "../../tools/shell-env.js";
import { isHostContaminationEnvKey } from "../../tools/env-contamination.js";

const CDP = "9222";
const ctx = { egressAllowlist: new Set<string>(), egressAllowlistConfigured: false, selfPort: "7007", egressMode: "permissive" as const, localServicePorts: new Set<string>(), manualHostPorts: new Set<string>() };

describe("the reserved CDP port is withheld from every agent path", () => {
  beforeEach(() => { process.env.LAX_ELECTRON_CDP_PORT = CDP; localOnly = false; disposable = false; });
  afterEach(() => { delete process.env.LAX_ELECTRON_CDP_PORT; });

  it("is the reserved set", () => {
    expect(reservedLoopbackPorts()).toEqual(new Set([CDP]));
  });

  it("strict local-only mode opens every loopback port except it", () => {
    localOnly = true;
    expect(evaluateWebFetch(ctx.egressAllowlist, false, "7007", `http://127.0.0.1:${CDP}/json/list`, "permissive", new Set(), new Set()).allowed).toBe(false);
    expect(evaluateWebFetch(ctx.egressAllowlist, false, "7007", "http://127.0.0.1:11434/api/tags", "permissive", new Set(), new Set()).allowed).toBe(true);
  });

  it("a disposable sandbox opens every loopback port except it, for http_request and the shell alike", () => {
    disposable = true;
    expect(loopbackServiceReachable(CDP, new Set())).toBe(false);
    expect(shellLoopbackReachable(CDP)).toBe(false);
    expect(loopbackServiceReachable("8188", new Set())).toBe(true);
    expect(shellLoopbackReachable("8188")).toBe(true);
  });

  it("the browser's localhost carve-out does not reach it", () => {
    expect(evaluateBrowserUrl(`http://127.0.0.1:${CDP}/json/list`, ctx).allowed).toBe(false);
    expect(evaluateBrowserUrl(`http://localhost:${CDP}/json/version`, ctx).allowed).toBe(false);
    expect(evaluateBrowserUrl("http://localhost:3000/", ctx).allowed).toBe(true);
  });

  it("never reaches a shell child's environment", () => {
    expect(isHostContaminationEnvKey("LAX_ELECTRON_CDP_PORT")).toBe(true);
    expect(buildSanitizedEnv().LAX_ELECTRON_CDP_PORT).toBeUndefined();
  });

  it("is nothing at all when native driving is off", () => {
    delete process.env.LAX_ELECTRON_CDP_PORT;
    expect(reservedLoopbackPorts().size).toBe(0);
    localOnly = true;
    expect(evaluateWebFetch(ctx.egressAllowlist, false, "7007", `http://127.0.0.1:${CDP}/`, "permissive", new Set(), new Set()).allowed).toBe(true);
  });
});
