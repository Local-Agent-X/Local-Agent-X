import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { SecurityLayer } from "../security/index.js";
import { assertToolCallAllowed, ToolBlocked, type PreDispatchCtx } from "./pre-dispatch.js";
import { getRuntimeConfig, setRuntimeConfig } from "../config.js";
import type { LAXConfig } from "../types.js";
import { ToolPolicy } from "../tool-policy/index.js";
import { setOpLedger, setEnforcedPlanMode, _resetOpLedgers, _resetEnforcedPlanMode } from "../canonical-loop/public/plan-ledger.js";

// ── F4 behavioral proof ──────────────────────────────────────────────────
// The pure SecurityLayer decision for sql_query paths is already unit-tested
// in src/security/layer-core.test.ts. This file proves the WIRING: that the
// executor's shared pre-dispatch chain (assertToolCallAllowed) actually
// routes sql_query through SecurityLayer and refuses an out-of-bounds caller
// path. We run assertToolCallAllowed END-TO-END (not the narrowed security
// pack) — that is the chain the tool executor calls, so it is the strongest
// proof the gate is consulted. The chain's other packs (default/threat/
// arikernel) tolerate undefined inputs, so the SecurityLayer pack is the only
// gate that fires for these database-path calls.
//
// Mirrors layer-core.test.ts exactly: SecurityLayer(WORKSPACE, "common") so
// allowed/blocked paths are deterministic and host-independent. tmpdir() lives
// outside the project root / ~/.lax / user dirs in "common" mode, so it is the
// canonical "outside" path; the workspace dir is the canonical "inside" path.

const WORKSPACE = "./workspace";

let savedLaxDir: string | undefined;
let suiteLaxDir: string;
let savedRuntime: LAXConfig | undefined;

function makeLayer() {
  return new SecurityLayer(WORKSPACE, "common");
}

function makeCtx(security: SecurityLayer): PreDispatchCtx {
  // Minimal ctx: skip the session-policy gate, route as a local call.
  // rbac/toolPolicy/threatEngine left undefined — the packs tolerate it,
  // leaving SecurityLayer as the only gate that can fire for these paths.
  return { sessionId: "test", callContext: "local", security, skipSessionPolicy: true };
}

beforeAll(() => {
  savedLaxDir = process.env.LAX_DATA_DIR;
  suiteLaxDir = mkdtempSync(join(tmpdir(), "pre-dispatch-test-"));
  process.env.LAX_DATA_DIR = suiteLaxDir;
  writeFileSync(
    join(suiteLaxDir, "egress-allowlist.json"),
    JSON.stringify([]),
    "utf-8",
  );

  // The kill-switches in assertToolCallAllowed read getRuntimeConfig() for
  // enableShell/enableHttp/enableBrowser. Pin them ON so the category gates
  // don't interfere — they sit ABOVE the rule packs and would short-circuit
  // before SecurityLayer if any category were off. (sql_query isn't in those
  // categories, but we keep the runtime config deterministic regardless.)
  try {
    savedRuntime = getRuntimeConfig();
  } catch {
    savedRuntime = undefined;
  }
  setRuntimeConfig({
    enableShell: true,
    enableHttp: true,
    enableBrowser: true,
  } as unknown as LAXConfig); // partial — only the three kill-switch flags are read here
});

afterAll(() => {
  if (savedRuntime) setRuntimeConfig(savedRuntime);
  if (savedLaxDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = savedLaxDir;
  rmSync(suiteLaxDir, { recursive: true, force: true });
});

describe("F4: executor pre-dispatch chain routes sql_query through SecurityLayer", () => {
  it("preserves confirm rules as approval-required instead of silently allowing", async () => {
    const policy = new ToolPolicy({
      defaultDecision: "deny",
      rules: [{
        id: "confirm-browser-evaluate",
        tool: "browser",
        action: "evaluate",
        decision: "confirm",
        reason: "Browser JS evaluation requires review",
      }],
    });

    try {
      await assertToolCallAllowed(
        { id: "confirm-1", name: "browser", args: { action: "evaluate" } },
        { sessionId: "test", callContext: "local", skipSessionPolicy: true, toolPolicy: policy },
      );
      throw new Error("expected ToolBlocked");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolBlocked);
      expect((e as ToolBlocked).disposition).toBe("approval-required");
      expect((e as ToolBlocked).message).toContain("APPROVAL REQUIRED");
    }
  });

  it("blocks sql_query whose database path is OUTSIDE the allowed dirs (chain consults SecurityLayer)", async () => {
    const security = makeLayer();
    const dbPath = join(tmpdir(), "lax-predispatch-outside-read.db");
    const call = {
      id: "c1",
      name: "sql_query",
      args: { database: dbPath, query: "SELECT 1" },
    };
    await expect(assertToolCallAllowed(call, makeCtx(security))).rejects.toBeInstanceOf(ToolBlocked);
    // And the block came from the security stage specifically.
    try {
      await assertToolCallAllowed(call, makeCtx(security));
      throw new Error("expected ToolBlocked");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolBlocked);
      expect((e as ToolBlocked).stage).toBe("security");
    }
  });

  it("allows sql_query whose database path is INSIDE the SecurityLayer workspace (read-gated)", async () => {
    const security = makeLayer();
    const dbPath = resolve(WORKSPACE, "data.db");
    const call = {
      id: "c2",
      name: "sql_query",
      args: { database: dbPath, query: "SELECT 1" },
    };
    await expect(assertToolCallAllowed(call, makeCtx(security))).resolves.toBeUndefined();
  });

  it("blocks a mutating sql_query (readonly:false) to an out-of-bounds path (write-gated)", async () => {
    const security = makeLayer();
    const dbPath = join(tmpdir(), "lax-predispatch-outside-write.db");
    const call = {
      id: "c3",
      name: "sql_query",
      args: { database: dbPath, query: "DELETE FROM t", readonly: false },
    };
    try {
      await assertToolCallAllowed(call, makeCtx(security));
      throw new Error("expected ToolBlocked");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolBlocked);
      expect((e as ToolBlocked).stage).toBe("security");
    }
  });
});

// ── Per-op instruction-ledger prohibitions ─────────────────────────────────
// The gate sits beside the category kill-switches: when the op's ledger
// records a user prohibition for a capability class, every tool IN that class
// (classified via hasCapability, so synonyms count) is hard-denied for that
// op — and NOTHING else changes. The regression half is the fail-open
// contract: no opId / no ledger / empty ledger must block nothing.
describe("per-op instruction-ledger capability prohibitions", () => {
  // No security/toolPolicy/threatEngine: the packs tolerate undefined, so the
  // ledger gate is the only gate that can fire for these calls.
  function opCtx(opId?: string): PreDispatchCtx {
    return { sessionId: "test", callContext: "local", skipSessionPolicy: true, opId };
  }

  afterEach(() => {
    _resetOpLedgers();
  });

  it("blocks workspace-write tools when the op ledger forbids workspace-write", async () => {
    setOpLedger("op-1", { prohibitions: ["workspace-write"], obligations: [], phrases: ["don't edit any code"] });
    for (const name of ["write", "edit"]) {
      try {
        await assertToolCallAllowed(
          { id: `p-${name}`, name, args: { path: "a.txt", content: "x" } },
          opCtx("op-1"),
        );
        throw new Error("expected ToolBlocked");
      } catch (e) {
        expect(e).toBeInstanceOf(ToolBlocked);
        expect((e as ToolBlocked).stage).toBe("tool-policy");
        expect((e as ToolBlocked).disposition).toBe("hard-deny");
        expect((e as ToolBlocked).reason).toContain("The user asked you not to edit or write files");
      }
    }
  });

  it("denial message QUOTES the ledger phrase the ban was extracted from", async () => {
    // Provenance in the denial is what makes a misextraction diagnosable from
    // the transcript (2026-07-22 Merchhelm: the bare wording left both the
    // blocked worker and the parent agent guessing at anchoring bugs).
    setOpLedger("op-1", { prohibitions: ["workspace-write"], obligations: [], phrases: ["Never touch paths outside it"] });
    try {
      await assertToolCallAllowed({ id: "p-w", name: "write", args: { path: "a.txt", content: "x" } }, opCtx("op-1"));
      throw new Error("expected ToolBlocked");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolBlocked);
      expect((e as ToolBlocked).reason).toContain('"Never touch paths outside it"');
    }
    // The shell escape hatch carries the same provenance.
    try {
      await assertToolCallAllowed({ id: "p-b", name: "bash", args: { command: "cp a.txt b.txt" } }, opCtx("op-1"));
      throw new Error("expected ToolBlocked");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolBlocked);
      expect((e as ToolBlocked).reason).toContain('"Never touch paths outside it"');
    }
  });

  it("blocks class synonyms (ari_file), not just canonical names", async () => {
    setOpLedger("op-1", { prohibitions: ["workspace-write"], obligations: [], phrases: ["don't edit any code"] });
    await expect(
      assertToolCallAllowed(
        { id: "p-ari", name: "ari_file", args: { action: "write", path: "a.txt" } },
        opCtx("op-1"),
      ),
    ).rejects.toBeInstanceOf(ToolBlocked);
  });

  it("still allows tools OUTSIDE the forbidden class (read passes under a workspace-write ban)", async () => {
    setOpLedger("op-1", { prohibitions: ["workspace-write"], obligations: [], phrases: ["don't edit any code"] });
    await expect(
      assertToolCallAllowed({ id: "p-read", name: "read", args: { path: "a.txt" } }, opCtx("op-1")),
    ).resolves.toBeUndefined();
  });

  it("blocks a MUTATING shell command under a workspace-write ban (closes the bash escape)", async () => {
    setOpLedger("op-1", { prohibitions: ["workspace-write"], obligations: [], phrases: ["don't edit anything"] });
    for (const command of ["sed -i 's/a/b/' src/x.ts", "echo x > src/x.ts", "rm src/x.ts", "cp a.ts b.ts"]) {
      try {
        await assertToolCallAllowed({ id: "p-bash", name: "bash", args: { command } }, opCtx("op-1"));
        throw new Error(`expected ToolBlocked for: ${command}`);
      } catch (e) {
        expect(e).toBeInstanceOf(ToolBlocked);
        expect((e as ToolBlocked).reason).toContain("writes to the filesystem");
      }
    }
  });

  it("allows READ-ONLY shell under a workspace-write ban (grep/ls/cat, benign redirect)", async () => {
    setOpLedger("op-1", { prohibitions: ["workspace-write"], obligations: [], phrases: ["don't edit anything"] });
    for (const command of ["grep -rn tailnet src", "ls -la", "cat src/x.ts", "echo hi > /dev/null 2>&1"]) {
      await expect(
        assertToolCallAllowed({ id: "p-bash", name: "bash", args: { command } }, opCtx("op-1")),
      ).resolves.toBeUndefined();
    }
  });

  it("REGRESSION fail-open: a mutating shell command is allowed with no workspace-write ban", async () => {
    setOpLedger("op-1", { prohibitions: [], obligations: [], phrases: [] });
    await expect(
      assertToolCallAllowed({ id: "p-bash", name: "bash", args: { command: "sed -i s/a/b/ x.ts" } }, opCtx("op-1")),
    ).resolves.toBeUndefined();
  });

  it("REGRESSION fail-open: empty ledger blocks nothing", async () => {
    setOpLedger("op-1", { prohibitions: [], obligations: [], phrases: [] });
    await expect(
      assertToolCallAllowed({ id: "p-w", name: "write", args: { path: "a.txt", content: "x" } }, opCtx("op-1")),
    ).resolves.toBeUndefined();
  });

  it("REGRESSION fail-open: no ledger recorded for the op blocks nothing", async () => {
    await expect(
      assertToolCallAllowed({ id: "p-w", name: "write", args: { path: "a.txt", content: "x" } }, opCtx("op-none")),
    ).resolves.toBeUndefined();
  });

  it("REGRESSION fail-open: no opId in ctx blocks nothing, even with a prohibition on record", async () => {
    setOpLedger("op-1", { prohibitions: ["workspace-write"], obligations: [], phrases: ["don't edit any code"] });
    await expect(
      assertToolCallAllowed({ id: "p-w", name: "write", args: { path: "a.txt", content: "x" } }, opCtx(undefined)),
    ).resolves.toBeUndefined();
  });

  it("scopes prohibitions to THEIR op — another op's ledger doesn't leak", async () => {
    setOpLedger("op-other", { prohibitions: ["workspace-write"], obligations: [], phrases: ["don't edit any code"] });
    await expect(
      assertToolCallAllowed({ id: "p-w", name: "write", args: { path: "a.txt", content: "x" } }, opCtx("op-1")),
    ).resolves.toBeUndefined();
  });

  it("blocks the registered edit/delete SYNONYMS under a workspace-write ban (class-hole regression)", async () => {
    // edit_lines / multi_edit / delete_file are the same blast radius as
    // write/edit; before they were enrolled in WORKSPACE_WRITE_TOOLS a ban
    // blocked `edit` but let `edit_lines` through.
    setOpLedger("op-1", { prohibitions: ["workspace-write"], obligations: [], phrases: ["don't edit any code"] });
    for (const name of ["edit_lines", "multi_edit", "delete_file"]) {
      await expect(
        assertToolCallAllowed({ id: `p-${name}`, name, args: { path: "a.txt" } }, opCtx("op-1")),
      ).rejects.toBeInstanceOf(ToolBlocked);
    }
  });
});

// ── Enforced plan mode — session-scoped standing mutation ban ───────────────
// Same gate as the per-op prohibitions above, different SOURCE: the user's
// Plan toggle sets a session-wide standing forbid the model cannot lift.
// Applies with or without an opId (delegated/kernel dispatches included), and
// the user's toggle-off (the approval event) unblocks the very next call.
describe("enforced plan mode at pre-dispatch", () => {
  function planCtx(sessionId: string, opId?: string): PreDispatchCtx {
    return { sessionId, callContext: "local", skipSessionPolicy: true, opId };
  }

  afterEach(() => {
    _resetEnforcedPlanMode();
    _resetOpLedgers();
  });

  it("hard-denies workspace-write tools (canonical AND synonyms) while enforced", async () => {
    setEnforcedPlanMode("plan-sess", true);
    for (const name of ["write", "edit", "edit_lines", "multi_edit", "delete_file", "ari_file"]) {
      try {
        await assertToolCallAllowed({ id: `pm-${name}`, name, args: { path: "a.txt", content: "x" } }, planCtx("plan-sess", "op-1"));
        throw new Error(`expected ToolBlocked for ${name}`);
      } catch (e) {
        expect(e).toBeInstanceOf(ToolBlocked);
        expect((e as ToolBlocked).disposition).toBe("hard-deny");
        expect((e as ToolBlocked).reason).toContain("Enforced plan mode");
      }
    }
  });

  it("applies WITHOUT an opId too — non-op dispatch paths can't sidestep the mode", async () => {
    setEnforcedPlanMode("plan-sess", true);
    await expect(
      assertToolCallAllowed({ id: "pm-noop", name: "write", args: { path: "a.txt", content: "x" } }, planCtx("plan-sess")),
    ).rejects.toBeInstanceOf(ToolBlocked);
  });

  it("blocks a MUTATING shell command but allows read-only shell", async () => {
    setEnforcedPlanMode("plan-sess", true);
    try {
      await assertToolCallAllowed({ id: "pm-sh", name: "bash", args: { command: "sed -i 's/a/b/' x.ts" } }, planCtx("plan-sess", "op-1"));
      throw new Error("expected ToolBlocked");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolBlocked);
      expect((e as ToolBlocked).reason).toContain("Enforced plan mode");
    }
    await expect(
      assertToolCallAllowed({ id: "pm-sh-ro", name: "bash", args: { command: "grep -rn foo src" } }, planCtx("plan-sess", "op-1")),
    ).resolves.toBeUndefined();
  });

  it("research stays allowed: read passes while enforced", async () => {
    setEnforcedPlanMode("plan-sess", true);
    await expect(
      assertToolCallAllowed({ id: "pm-read", name: "read", args: { path: "a.txt" } }, planCtx("plan-sess", "op-1")),
    ).resolves.toBeUndefined();
  });

  it("the approval event (toggle off) unblocks the next call immediately, mid-op", async () => {
    setEnforcedPlanMode("plan-sess", true);
    await expect(
      assertToolCallAllowed({ id: "pm-w1", name: "write", args: { path: "a.txt", content: "x" } }, planCtx("plan-sess", "op-1")),
    ).rejects.toBeInstanceOf(ToolBlocked);
    setEnforcedPlanMode("plan-sess", false);
    await expect(
      assertToolCallAllowed({ id: "pm-w2", name: "write", args: { path: "a.txt", content: "x" } }, planCtx("plan-sess", "op-1")),
    ).resolves.toBeUndefined();
  });

  it("is scoped to ITS session — other sessions are untouched", async () => {
    setEnforcedPlanMode("plan-sess", true);
    await expect(
      assertToolCallAllowed({ id: "pm-other", name: "write", args: { path: "a.txt", content: "x" } }, planCtx("other-sess", "op-2")),
    ).resolves.toBeUndefined();
  });

  it("a user-stated op prohibition keeps its own wording (plan mode doesn't rewrite it)", async () => {
    setOpLedger("op-1", { prohibitions: ["workspace-write"], obligations: [], phrases: ["don't edit"] });
    setEnforcedPlanMode("plan-sess", true);
    try {
      await assertToolCallAllowed({ id: "pm-both", name: "write", args: { path: "a.txt", content: "x" } }, planCtx("plan-sess", "op-1"));
      throw new Error("expected ToolBlocked");
    } catch (e) {
      expect((e as ToolBlocked).reason).toContain("The user asked you not to");
    }
  });
});
