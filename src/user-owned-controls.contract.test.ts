/**
 * CROSS-SEAM CONTRACT: the agent may REQUEST a user-owned security control
 * change; it may never self-apply one.
 *
 * A "user-owned control" is anything that decides what the agent is allowed to
 * do: the 13 `protected: true` settings, the file-access mode, and the tool
 * policy table. Each has more than one mutation path, and the class of bug this
 * file exists to prevent is a rule enforced at ONE seam and absent at the
 * siblings.
 *
 * Incident that motivated it (2026-07-25): an agent blocked on an email task
 * called setting(developer_mode, true), got `ok`, and opened a self_edit
 * worktree on its own source 25 seconds later. The system prompt said verbatim
 * that developer_mode "is a user-owned control you cannot flip for them" — but
 * the only code-level guard skipped interactive sessions. In the same sweep:
 * POST /api/security/file-access and POST /api/tool-policy/toggle were reachable
 * by the agent RBAC role with no operator check, and ~/.lax/settings.json was
 * writable by the plain `write` tool in every file-access mode.
 *
 * SEAMS COVERED — add a row here whenever a new mutation path appears:
 *   1. `setting` tool          → tool-execution/protected-setting-gate.ts
 *   2. POST /api/security/*    → rbac.ts agent deniedEndpoints
 *   3. POST /api/tool-policy/* → rbac.ts agent deniedEndpoints
 *   4. raw file write          → security/layer/lax-control-files.ts
 *   5. POST /api/settings      → routes/settings/preferences.ts operator token
 *      (covered by its own route tests; asserted here only as a reminder row)
 */
import { describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { PROTECTED_SETTINGS, isProtectedSetting } from "./settings-schema.js";
import { RBACManager } from "./rbac.js";
import { evaluateFileAccess } from "./security/layer/file-access.js";
import { isLaxControlFile, laxControlFileBasenames } from "./security/layer/lax-control-files.js";
import {
  enforceProtectedSettingGate,
  ProtectedSettingDenied,
  protectedFieldOf,
} from "./tool-execution/protected-setting-gate.js";

const FIELDS = [...PROTECTED_SETTINGS];

// ── Seam 1: the `setting` tool ────────────────────────────────────────────
describe("seam 1 — `setting` tool cannot self-apply a protected control", () => {
  const call = (field: string, value: unknown) => ({
    id: "call-1",
    name: "setting",
    args: { field, value } as Record<string, unknown>,
  });
  const approver = (answer: boolean) => {
    let asked = 0;
    return {
      manager: {
        async requestApproval() { asked++; return answer; },
      },
      asked: () => asked,
    };
  };
  const localCtx = {
    sessionId: "s1",
    callContext: "local" as const,
    approval: { onEvent: () => {} },
  };

  it("guards EVERY protected setting — no field is exempt", () => {
    expect(FIELDS.length).toBeGreaterThan(0);
    for (const field of FIELDS) {
      expect(protectedFieldOf(call(field, true))).toBe(field);
    }
  });

  it.each(FIELDS)("refuses %s outright in an autonomous run", async (field) => {
    for (const callContext of ["api", "delegated", "cron"] as const) {
      const a = approver(true);
      await expect(
        enforceProtectedSettingGate(call(field, true), { sessionId: "s", callContext }, a.manager),
      ).rejects.toBeInstanceOf(ProtectedSettingDenied);
      // Never even asked — there is no user on the other end to ask.
      expect(a.asked()).toBe(0);
    }
  });

  it.each(FIELDS)("requires an explicit approval for %s in interactive chat", async (field) => {
    const a = approver(true);
    const outcome = await enforceProtectedSettingGate(call(field, true), localCtx, a.manager);
    expect(outcome).toBe("approved");
    // The load-bearing assertion: it ASKED. Silent application is the bug.
    expect(a.asked()).toBe(1);
  });

  it.each(FIELDS)("refuses %s when the user declines", async (field) => {
    const a = approver(false);
    await expect(
      enforceProtectedSettingGate(call(field, true), localCtx, a.manager),
    ).rejects.toBeInstanceOf(ProtectedSettingDenied);
  });

  it("refuses when interactive but no approval channel exists", async () => {
    const a = approver(true);
    await expect(
      enforceProtectedSettingGate(
        call("developer_mode", true),
        { sessionId: "s", callContext: "local" },
        a.manager,
      ),
    ).rejects.toBeInstanceOf(ProtectedSettingDenied);
    expect(a.asked()).toBe(0);
  });

  // The other half of the contract: ordinary settings stay frictionless.
  it.each(["theme", "provider", "model", "temperature", "maxIterations", "reasoningEffort"])(
    "leaves the non-security setting %s completely ungated",
    async (field) => {
      expect(isProtectedSetting(field)).toBe(false);
      const a = approver(false);
      const outcome = await enforceProtectedSettingGate(call(field, "dark"), localCtx, a.manager);
      expect(outcome).toBe("not-protected");
      expect(a.asked()).toBe(0);
    },
  );

  it("ignores non-`setting` tools", async () => {
    const a = approver(false);
    const outcome = await enforceProtectedSettingGate(
      { id: "c", name: "bash", args: { field: "developer_mode", value: true } },
      localCtx,
      a.manager,
    );
    expect(outcome).toBe("not-protected");
  });
});

// ── Seams 2 & 3: agent-reachable HTTP routes ──────────────────────────────
describe("seams 2 & 3 — the agent RBAC role cannot reach its own leash", () => {
  const tmpDir = join(tmpdir(), `lax-uoc-contract-${randomBytes(6).toString("hex")}`);
  mkdirSync(tmpDir, { recursive: true });
  const rbac = new RBACManager(tmpDir, randomBytes(32).toString("hex"));

  // Every route that mutates a user-owned control and is NOT behind its own
  // operator-token check. RBAC is the only thing standing in front of these.
  const SELF_GATING_ROUTES = [
    ["POST", "/api/security/file-access"],
    ["POST", "/api/tool-policy/toggle"],
    ["GET", "/api/security/file-access"],
    ["GET", "/api/tool-policy/status"],
  ] as const;

  it.each(SELF_GATING_ROUTES)("agent role is denied %s %s", (method, path) => {
    expect(rbac.checkEndpoint("agent", method, path).allowed).toBe(false);
  });

  it("the operator role still reaches them (the UI must keep working)", () => {
    for (const [method, path] of SELF_GATING_ROUTES) {
      expect(rbac.checkEndpoint("operator", method, path).allowed).toBe(true);
    }
  });

  it("keeps the previously-closed sensitive sinks denied to the agent", () => {
    for (const p of ["/api/secrets", "/api/tokens", "/api/plugins", "/api/auth", "/api/audit", "/api/logs", "/api/local-runtimes"]) {
      expect(rbac.checkEndpoint("agent", "POST", p).allowed).toBe(false);
    }
  });

  it("leaves the agent's benign self-calls alone", () => {
    for (const p of ["/api/settings", "/api/sessions", "/api/health"]) {
      expect(rbac.checkEndpoint("agent", "GET", p).allowed).toBe(true);
    }
  });
});

// ── Seam 4: raw file write to the data-dir control files ──────────────────
describe("seam 4 — control files cannot be rewritten by the file tools", () => {
  const workspace = join(tmpdir(), "uoc-ws");
  const allowAll = () => true;
  const MODES = ["workspace", "common", "unrestricted"] as const;
  const targets = laxControlFileBasenames().map((b) => join(tmpdir(), ".lax", b));

  it("recognises the control files, and only inside a .lax dir", () => {
    expect(isLaxControlFile("/home/u/.lax/settings.json")).toBe(true);
    expect(isLaxControlFile("C:\\Users\\u\\.lax\\tool-policy.json")).toBe(true);
    // A user's OWN project file of the same name is none of our business.
    expect(isLaxControlFile("/home/u/projects/app/settings.json")).toBe(false);
    expect(isLaxControlFile("/home/u/.lax/notes.md")).toBe(false);
  });

  it.each(MODES)("blocks writes in %s mode — including unrestricted", (mode) => {
    for (const t of targets) {
      for (const action of ["write", "edit", "delete"]) {
        const d = evaluateFileAccess(workspace, mode, allowAll, action, t);
        expect(d.allowed, `${action} ${t} in ${mode}`).toBe(false);
      }
    }
  });

  it.each(MODES)("still permits READS in %s mode (config is not a secret)", (mode) => {
    // Reading your own configuration is benign and the agent depends on it;
    // only mutation is escalation. A read block here would be a regression.
    for (const t of targets) {
      const d = evaluateFileAccess(workspace, mode, allowAll, "read", t);
      expect(d.reason ?? "").not.toMatch(/user-owned control file/);
    }
  });
});

// ── The completeness invariant ────────────────────────────────────────────
describe("no user-owned control is left without a seam", () => {
  it("settings.json is the file that carries the protected settings", () => {
    // If the protected settings ever move out of settings.json, seam 4's
    // basename list must move with them or the write block silently stops
    // covering anything.
    expect(laxControlFileBasenames()).toContain("settings.json");
  });

  // security.json was missing from seam 4 until 2026-07-29 while holding
  // egressMode, the egress allowlist, localServicePorts and inlineEvalPolicy —
  // i.e. an agent in unrestricted file mode could open outbound egress to any
  // host, whitelist a loopback port, or switch OFF the inline-eval refusal, with
  // one raw file write that walks past the `setting` approval gate, the operator
  // token on POST /api/settings, and the RBAC deny on /api/security all at once.
  // The gap was also cited (correctly) as the reason a forged dev-server record
  // "grants no new authority" — so closing it removes that excuse too.
  it("security.json is covered — it carries egressMode, the allowlist and inlineEvalPolicy", () => {
    expect(laxControlFileBasenames()).toContain("security.json");
    expect(isLaxControlFile("/home/u/.lax/security.json")).toBe(true);
    // Still scoped to OUR data dir: a user's own project security.json is theirs.
    expect(isLaxControlFile("/home/u/projects/app/security.json")).toBe(false);
  });

  it("every protected setting is enforced by the gate, not by prompt text", () => {
    // A field marked protected in the schema but not recognised by the gate is
    // exactly the developer_mode bug, re-introduced.
    for (const field of FIELDS) {
      expect(
        protectedFieldOf({ id: "c", name: "setting", args: { field, value: true } }),
        `${field} is marked protected in settings-schema but the gate does not recognise it`,
      ).toBe(field);
    }
  });
});
