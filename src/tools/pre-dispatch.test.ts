import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { SecurityLayer } from "../security/index.js";
import { assertToolCallAllowed, ToolBlocked, type PreDispatchCtx } from "./pre-dispatch.js";
import { getRuntimeConfig, setRuntimeConfig } from "../config.js";
import type { LAXConfig } from "../types.js";

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
