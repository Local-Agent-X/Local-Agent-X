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
 *   6. POST /api/sandbox/*     → rbac.ts agent deniedEndpoints (the shell cage)
 *   7. POST /api/autonomy/*    → rbac.ts agent deniedEndpoints (approval profile)
 *
 * A change that can only NARROW the agent (settings-change-direction.ts) is
 * not one the agent needs leave for, so seam 1 applies it without a card; the
 * cases below each widen the field they name.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  ProtectedSettingNeedsApproval,
  userOwnedFieldOf,
} from "./tool-execution/protected-setting-gate.js";

const FIELDS = [...PROTECTED_SETTINGS];

// For each protected field, a value that widens the agent from the value
// CURRENT holds. Covering every field is asserted below.
const WIDENING: Record<string, unknown> = {
  enableShell: true, enableHttp: true, enableBrowser: true, enableComputerControl: true,
  enableRemoteControl: true, enableUiEventBus: true, skillReviewEnabled: true, developer_mode: true,
  localOnlyMode: false, supervisedBrowser: false, learningMode: "autonomous", browserSecrecy: "open",
  browserMode: "advanced-shared", toolApproval: "auto",
};
const CURRENT: Record<string, unknown> = { toolApproval: "confirm-all", browserMode: "isolated" };
const readCurrent = (field: string) => CURRENT[field];

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
    expect(Object.keys(WIDENING).sort()).toEqual([...FIELDS].sort());
    for (const field of FIELDS) {
      expect(userOwnedFieldOf(call(field, true))).toBe(field);
    }
  });

  it.each(FIELDS)("refuses widening %s outright in an autonomous run", async (field) => {
    for (const callContext of ["api", "delegated", "cron"] as const) {
      const a = approver(true);
      await expect(
        enforceProtectedSettingGate(call(field, WIDENING[field]), { sessionId: "s", callContext }, a.manager, readCurrent),
      ).rejects.toBeInstanceOf(ProtectedSettingDenied);
      // Never even asked — there is no user on the other end to ask.
      expect(a.asked()).toBe(0);
    }
  });

  it.each(FIELDS)("requires an explicit approval to widen %s in interactive chat", async (field) => {
    const a = approver(true);
    const outcome = await enforceProtectedSettingGate(call(field, WIDENING[field]), localCtx, a.manager, readCurrent);
    expect(outcome).toBe("approved");
    // The load-bearing assertion: it ASKED. Silent application is the bug.
    expect(a.asked()).toBe(1);
  });

  it.each(FIELDS)("refuses widening %s when the user declines", async (field) => {
    const a = approver(false);
    await expect(
      enforceProtectedSettingGate(call(field, WIDENING[field]), localCtx, a.manager, readCurrent),
    ).rejects.toBeInstanceOf(ProtectedSettingDenied);
  });

  // The tool pipeline passes no approval channel here: its own approval phase
  // shows the card (protected-setting-pipeline.test.ts drives that end to end).
  it("hands the question to the caller's approval phase when it has no channel of its own", async () => {
    const a = approver(true);
    await expect(
      enforceProtectedSettingGate(
        call("developer_mode", true),
        { sessionId: "s", callContext: "local" },
        a.manager,
        readCurrent,
      ),
    ).rejects.toBeInstanceOf(ProtectedSettingNeedsApproval);
    expect(a.asked()).toBe(0);
  });

  // The owner's rule: no card that tells him nothing new. Switching a
  // capability off, or supervision on, narrows the agent in every context.
  it.each([
    ["enableShell", false], ["enableHttp", false], ["enableBrowser", false], ["enableComputerControl", false],
    ["localOnlyMode", true], ["developer_mode", false], ["supervisedBrowser", true], ["browserSecrecy", "lockdown"],
    ["toolApproval", "confirm-all"],
  ] as const)("applies %s → %s without a card, even in a background run", async (field, value) => {
    for (const ctx of [localCtx, { sessionId: "s", callContext: "cron" as const }]) {
      const a = approver(false);
      const outcome = await enforceProtectedSettingGate(call(field, value), ctx, a.manager, readCurrent);
      expect(outcome).toBe("tightens");
      expect(a.asked()).toBe(0);
    }
  });

  it("asks before toolApproval moves from confirm-all to confirm-risky", async () => {
    const a = approver(true);
    expect(await enforceProtectedSettingGate(call("toolApproval", "confirm-risky"), localCtx, a.manager, readCurrent)).toBe("approved");
    expect(a.asked()).toBe(1);
  });

  // The spending caps are the user's money: lowering one is free, raising one
  // or removing it (0 = no cap) asks, and a background run cannot.
  describe("spending caps", () => {
    const caps = (field: string) => ({ dailyBudgetUsd: 75, sessionBudgetUsd: 15, modelDailyBudgetsUsd: { "gpt-x": 10 } } as Record<string, unknown>)[field];

    it.each([
      ["dailyBudgetUsd", 20], ["dailyBudgetUsd", 75], ["sessionBudgetUsd", 5],
      ["modelDailyBudgetsUsd", { "gpt-x": 5 }], ["modelDailyBudgetsUsd", { "gpt-x": 10, "other": 3 }],
    ] as const)("lowers %s to %j without a card", async (field, value) => {
      const a = approver(false);
      expect(await enforceProtectedSettingGate(call(field, value), localCtx, a.manager, caps)).toBe("tightens");
      expect(a.asked()).toBe(0);
    });

    it.each([
      ["dailyBudgetUsd", 500], ["dailyBudgetUsd", 0], ["sessionBudgetUsd", 0], ["sessionBudgetUsd", 16],
      ["modelDailyBudgetsUsd", {}], ["modelDailyBudgetsUsd", { "gpt-x": 0 }], ["modelDailyBudgetsUsd", { "gpt-x": 11 }],
    ] as const)("asks before %s → %j, and refuses it in a background run", async (field, value) => {
      const a = approver(true);
      expect(await enforceProtectedSettingGate(call(field, value), localCtx, a.manager, caps)).toBe("approved");
      expect(a.asked()).toBe(1);
      await expect(
        enforceProtectedSettingGate(call(field, value), { sessionId: "s", callContext: "cron" }, approver(true).manager, caps),
      ).rejects.toBeInstanceOf(ProtectedSettingDenied);
    });

    it("names the money in the card", async () => {
      let context = "";
      const manager = { async requestApproval(input: { context: string }) { context = input.context; return true; } };
      await enforceProtectedSettingGate(call("dailyBudgetUsd", 0), localCtx, manager, caps);
      expect(context).toBe("Change the daily spending cap on API-key usage from $75 to no cap?");
    });
  });

  it("tells the user developer mode unlocks self_edit and autopilot, and stays on until they turn it off", async () => {
    let context = "";
    const manager = { async requestApproval(input: { context: string }) { context = input.context; return true; } };
    await enforceProtectedSettingGate(call("developer_mode", true), localCtx, manager, readCurrent);
    expect(context).toMatch(/self_edit and autopilot/);
    expect(context).toMatch(/stays on until you turn it off in Settings/);
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
    ["POST", "/api/sandbox"],
    ["POST", "/api/sandbox/windows-cage"],
    ["POST", "/api/autonomy/profile"],
    ["POST", "/api/mcp/servers"],
    ["POST", "/api/sync/pull"],
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
      for (const action of ["write", "edit", "delete_file"]) {
        const d = evaluateFileAccess(workspace, mode, allowAll, action, t);
        expect(d.allowed, `${action} ${t} in ${mode}`).toBe(false);
      }
    }
  });

  // Windows writes the real settings.json through each of these spellings,
  // and unrestricted mode allows any write under home, so the block is all
  // that stands in the way.
  describe.skipIf(process.platform !== "win32")("the other Windows spellings of the same file", () => {
    let base = "";
    let lax = "";
    beforeEach(() => {
      base = mkdtempSync(join(tmpdir(), "uoc-spell-"));
      lax = join(base, ".lax");
      mkdirSync(lax);
      writeFileSync(join(lax, "settings.json"), "{}");
    });
    afterEach(() => rmSync(base, { recursive: true, force: true }));
    const blocked = (p: string) => {
      const d = evaluateFileAccess(workspace, "unrestricted", allowAll, "write", p);
      expect(d.allowed, p).toBe(false);
      expect(d.reason, p).toMatch(/user-owned control file/);
    };
    const sameAs = (a: string, b: string) => existsSync(a) && realpathSync.native(a) === realpathSync.native(b);

    it("a stream suffix on the file or the folder, including a file that does not exist yet", () => {
      blocked(`${join(lax, "settings.json")}::$DATA`);
      blocked(join(`${lax}::$INDEX_ALLOCATION`, "settings.json"));
      blocked(`${join(lax, "security.json")}::$DATA`);
    });

    it("an 8.3 short name for the data dir or the file, where the volume keeps them", (t) => {
      if (!sameAs(join(base, "LAX~1"), lax) || !sameAs(join(lax, "SETTIN~1.JSO"), join(lax, "settings.json"))) return t.skip();
      blocked(join(base, "LAX~1", "settings.json"));
      blocked(join(base, "LAX~1", "tool-policy.json"));
      blocked(join(lax, "SETTIN~1.JSO"));
    });
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
        userOwnedFieldOf({ id: "c", name: "setting", args: { field, value: true } }),
        `${field} is marked protected in settings-schema but the gate does not recognise it`,
      ).toBe(field);
    }
  });
});
