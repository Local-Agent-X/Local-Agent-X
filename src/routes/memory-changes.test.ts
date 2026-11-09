import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIndex } from "../memory/index.js";
import { authorizeTestFactMutations } from "../memory/test-promotion.test-helper.js";
import { handleMemoryChangeRoutes } from "./memory-changes.js";
import type { Role } from "../rbac.js";
import type { ServerContext } from "../server-context.js";

let tempDir: string;
let memory: MemoryIndex;
const broadcastAll = vi.fn();

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "lax-changes-route-"));
  mkdirSync(join(tempDir, "memory", "bank", "entities"), { recursive: true });
  memory = new MemoryIndex(tempDir, { minScore: -1 });
  authorizeTestFactMutations(memory);
  broadcastAll.mockReset();
});

afterEach(() => {
  try { memory.close(); } catch {}
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

async function call(method: string, path: string, role: Role = "operator") {
  const req = Readable.from([]) as Readable & { headers: Record<string, string> };
  req.headers = {};
  const res = { statusCode: 0, body: "", writeHead(s: number) { res.statusCode = s; return res; }, setHeader() {}, end(b?: string) { if (b) res.body = b; return res; } };
  const ctx = { memoryIndex: memory, broadcastAll } as unknown as ServerContext;
  const handled = await handleMemoryChangeRoutes(method, new URL(`http://x${path}`), req as never, res as never, ctx, role);
  return { handled, status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

describe("/api/memory/changes", () => {
  it("lists what changed, by whom and why, and undoes it for the operator", async () => {
    const id = memory.rememberFact("@Reta vial is 50 mg with 2 mL bac water", { kind: "world", sourceFile: "agent-tool:user-statement" }).fact!.id!;
    memory.invalidateFact(id, { by: "agent", reason: "agent forget" });

    const list = await call("GET", "/api/memory/changes?q=reta");
    expect(list.status).toBe(200);
    const [change] = list.body.items;
    expect(change).toMatchObject({ factId: id, op: "end", actor: "agent", reason: "agent forget", undoable: true });
    expect(change.text).toContain("50 mg");

    expect((await call("POST", `/api/memory/changes/${change.id}/undo`, "viewer" as Role)).status).toBe(403);
    const undo = await call("POST", `/api/memory/changes/${change.id}/undo`);
    expect(undo).toMatchObject({ status: 200, body: { ok: true, factId: id } });
    expect(broadcastAll).toHaveBeenCalledWith({ type: "settings_changed", settings: { memoryChanges: true } });
    expect((await call("POST", `/api/memory/changes/${change.id}/undo`)).status).toBe(409);
  });

  it("leaves other paths alone", async () => {
    expect((await call("GET", "/api/memory/stats")).handled).toBe(false);
  });
});
