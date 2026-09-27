// protocol(action:"get") counts as use only when a person's operation read the
// skill. LAX's own maintenance passes (the review fork, memory consolidation)
// made 176 of 266 logged "invocations" and ranked agent-written notes popular.
import { describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OPS = mkdtempSync(join(tmpdir(), "lax-protocol-usage-ops-"));
vi.mock("../ops/op-store.js", async () => {
  const { existsSync, readFileSync } = await import("node:fs");
  const { join: j } = await import("node:path");
  return { readOp: (id: string) => { const f = j(OPS, id, "operation.json"); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null; } };
});

const { createCoreProtocolTools } = await import("./index.js");
const { readAllUsage } = await import("./usage.js");

const op = (id: string, type: string) => {
  mkdirSync(join(OPS, id), { recursive: true });
  writeFileSync(join(OPS, id, "operation.json"), JSON.stringify({ id, type }));
};
const get = createCoreProtocolTools().find((t) => t.name === "protocol_get")!;
const invokedWith = (name: string) => readAllUsage().filter((r) => r.action === "invoked" && r.name === name).length;

describe("protocol get usage", () => {
  it("a chat turn's read counts; the review fork's and memory consolidation's do not", async () => {
    op("op_chat_turn_1", "chat_turn");
    op("op_skill_review_1", "skill_review");
    op("op_memory_consolidation_1", "memory_consolidation");
    const before = invokedWith("wrangler");
    await get.execute({ name: "wrangler", _operationId: "op_skill_review_1" });
    await get.execute({ name: "wrangler", _operationId: "op_memory_consolidation_1" });
    expect(invokedWith("wrangler")).toBe(before);
    await get.execute({ name: "wrangler", _operationId: "op_chat_turn_1" });
    expect(invokedWith("wrangler")).toBe(before + 1);
  });

  it("a shipped vendor skill lists its files, and serves one on request", async () => {
    const skill = await get.execute({ name: "cloudflare" });
    expect(String(skill.content)).toMatch(/Files this skill refers to/);
    const file = String(skill.content).split("\n").find((l) => /^\s{2}\S+\.md$/.test(l))!.trim();
    const read = await get.execute({ name: "cloudflare", file });
    expect(read.isError).toBeFalsy();
    expect(String(read.content)).toContain(`# cloudflare — ${file}`);
    expect((await get.execute({ name: "cloudflare", file: "../../../../package.json" })).isError).toBe(true);
  });
});
