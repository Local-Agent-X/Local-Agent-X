import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { opDir } from "../ops/event-log.js";
import { setAriRequired } from "../ari-kernel/state.js";
import type { ToolDefinition, ToolResult } from "../types.js";
import { dispatchSingleToolCall } from "./execute-tool.js";

const opIds: string[] = [];
let seq = 0;

function opId(label: string): string {
  const id = `op_journal_${label}_${process.pid}_${seq++}`;
  opIds.push(id);
  return id;
}

function mutationTool(execute: ToolDefinition["execute"]): ToolDefinition {
  return {
    name: "journal_mutation",
    description: "journal regression probe",
    parameters: { type: "object" },
    effect: { class: "non-idempotent" },
    execute,
  };
}

async function dispatch(
  operationId: string,
  tool: ToolDefinition,
  args: Record<string, unknown>,
  sessionId: string,
): Promise<ToolResult> {
  return dispatchSingleToolCall(
    { id: "stable-call", name: tool.name, args },
    {
      toolMap: new Map([[tool.name, tool]]),
      security: undefined as never,
      sessionId,
      operationId,
      callContext: "local",
    },
  );
}

function journalFile(operationId: string): string {
  const dir = join(opDir(operationId), "side-effects");
  const files = readdirSync(dir).filter(file => file.endsWith(".json"));
  expect(files).toHaveLength(1);
  return join(dir, files[0]);
}

beforeAll(() => setAriRequired(false));
afterAll(() => setAriRequired(true));
afterEach(() => {
  while (opIds.length > 0) rmSync(opDir(opIds.pop()!), { recursive: true, force: true });
});

describe("side-effect journal integrity and claims", () => {
  it("atomically claims a concurrent identical call so the effect executes once", async () => {
    const operationId = opId("concurrent");
    let executions = 0;
    let announceStarted!: () => void;
    let releaseEffect!: () => void;
    const started = new Promise<void>(resolve => { announceStarted = resolve; });
    const release = new Promise<void>(resolve => { releaseEffect = resolve; });
    const tool = mutationTool(async () => {
      executions++;
      announceStarted();
      await release;
      return { content: "effect-complete" };
    });

    const first = dispatch(operationId, tool, { value: 1 }, "claim-first");
    await started;
    const duplicate = await dispatch(operationId, tool, { value: 1 }, "claim-second");
    releaseEffect();
    const original = await first;

    expect(executions).toBe(1);
    expect(original.content).toContain("effect-complete");
    expect(duplicate.isError).toBe(true);
    expect(duplicate.content).toContain("execution_in_progress");
  });

  it("binds one call identity to one fingerprint and blocks changed args", async () => {
    const operationId = opId("fingerprint");
    let executions = 0;
    const tool = mutationTool(async args => {
      executions++;
      return { content: `effect:${String(args.value)}` };
    });

    await dispatch(operationId, tool, { value: "original" }, "fingerprint-first");
    const mismatch = await dispatch(operationId, tool, { value: "changed" }, "fingerprint-second");

    expect(executions).toBe(1);
    expect(mismatch.isError).toBe(true);
    expect(mismatch.content).toContain("journal_integrity_failure");
    expect(readdirSync(join(opDir(operationId), "side-effects")).filter(file => file.endsWith(".json"))).toHaveLength(1);
  });

  it.each([
    ["completed result missing", (entry: Record<string, unknown>) => { delete entry.result; }],
    ["unknown state", (entry: Record<string, unknown>) => { entry.state = "corrupt-state"; }],
    ["identity mismatch", (entry: Record<string, unknown>) => { entry.operationId = "different-op"; }],
    ["invalid result shape", (entry: Record<string, unknown>) => { entry.result = { content: 42 }; }],
  ])("fails closed on valid-JSON corruption: %s", async (label, corrupt) => {
    const operationId = opId(`corrupt-${label.replaceAll(" ", "-")}`);
    let executions = 0;
    const tool = mutationTool(async () => {
      executions++;
      return { content: "non-idempotent-effect" };
    });
    const args = { transfer: "fixed" };
    await dispatch(operationId, tool, args, `corrupt-first-${label}`);
    const path = journalFile(operationId);
    const entry = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    corrupt(entry);
    writeFileSync(path, JSON.stringify(entry, null, 2));

    const blocked = await dispatch(operationId, tool, args, `corrupt-second-${label}`);

    expect(executions).toBe(1);
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain("journal_integrity_failure");
  });

  it("fails closed on malformed JSON without repeating a non-idempotent effect", async () => {
    const operationId = opId("malformed-json");
    let executions = 0;
    const tool = mutationTool(async () => {
      executions++;
      return { content: "non-idempotent-effect" };
    });
    const args = { transfer: "fixed" };
    await dispatch(operationId, tool, args, "malformed-first");
    writeFileSync(journalFile(operationId), "{not-json");

    const blocked = await dispatch(operationId, tool, args, "malformed-second");

    expect(executions).toBe(1);
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain("journal_integrity_failure");
  });
});
