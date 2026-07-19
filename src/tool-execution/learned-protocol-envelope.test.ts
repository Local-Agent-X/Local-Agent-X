import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getRuntimeConfig, setRuntimeConfig } from "../config.js";
import type { LAXConfig, ToolDefinition } from "../types.js";
import { createCoreProtocolTools } from "../protocols/index.js";
import { createProtocolFamilyTools } from "../protocols/protocol-tool.js";
import {
  activateLearnedProtocol, archiveLearnedProtocol, createLearnedProtocolDraft,
  resolveActiveLearnedProtocolProvenance, rollbackLearnedProtocol,
} from "../protocols/learned-lifecycle.js";
import { importedProtocolsDir, learnedProtocolsDir } from "../protocols/loader.js";
import {
  clearLearnedProtocolEnvelopeForOp, getLearnedProtocolEnvelopeForOp,
  registerLearnedProtocolEnvelopeForOp,
} from "../canonical-loop/public/learned-protocols.js";
import { resetCanonicalRuntime, unregisterToolDispatcherForOp } from "../canonical-loop/index.js";
import { createContext } from "./context.js";
import { resolvePhase } from "./resolve-tool.js";
import { enforcePolicyPhase } from "./enforce-policy.js";
import { learnedProtocolEnvelopeGate } from "./learned-protocol-envelope.js";
import { setAriRequired } from "../ari-kernel/state.js";
import { getLaxDir } from "../lax-data-dir.js";
import { executeToolCalls } from "./execute-tool.js";

vi.mock("./side-effect-journal.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./side-effect-journal.js")>(),
  prepareSideEffect: () => ({ kind: "untracked" }),
}));

const ORIGINAL_CONFIG = getRuntimeConfig();
let workspaceRoot = "";
let opCounter = 0;
const testOps = new Set<string>();

function opId(): string {
  const id = `learned-envelope-${++opCounter}`;
  testOps.add(id);
  return id;
}

function skill(slug: string, allowedTools: string[] = ["read"]): string {
  return `---\nname: ${slug}\ndescription: Learned workflow\nallowed-tools: [${allowedTools.join(", ")}]\n---\n\nUse the verified workflow.\n`;
}

function candidateId(slug: string): string {
  return `learned-${createHash("sha256").update(slug).digest("hex").slice(0, 20)}`;
}

function metadata(candidateId: string, allowedTools: string[] | undefined): Record<string, unknown> {
  return {
    candidateId,
    evidenceSnapshot: { patternType: "workflow", occurrences: 3 },
    confidence: 1,
    ...(allowedTools === undefined ? {} : { allowedTools }),
    toolSequence: allowedTools ?? [],
    evidenceHash: "evidence",
  };
}

function protocolGet(): ToolDefinition {
  const tool = createCoreProtocolTools().find((candidate) => candidate.name === "protocol_get");
  if (!tool) throw new Error("protocol_get tool not found");
  return tool;
}

function testTool(name = "read"): ToolDefinition {
  return {
    name,
    description: "test tool",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    execute: async () => ({ content: "executed" }),
  };
}

function activeLearned(label: string, allowedTools: string[] | null = ["read"]) {
  const slug = candidateId(label);
  const draft = createLearnedProtocolDraft({
    slug,
    skillMd: skill(slug, allowedTools ?? ["read"]),
    metadata: metadata(slug, allowedTools ?? undefined),
  });
  activateLearnedProtocol({ slug, versionId: draft.version.id, expectedActiveVersionId: null });
  return draft;
}

async function select(slug: string, operationId: string): Promise<void> {
  const tool = protocolGet();
  const ctx = createContext({
    tc: { id: "select", name: tool.name, arguments: JSON.stringify({ name: slug, _operationId: "forged" }) },
    toolMap: new Map([[tool.name, tool]]),
    security: undefined as never,
    operationId,
  });
  expect((await resolvePhase(ctx)).kind).toBe("continue");
  expect(ctx.args._operationId).toBe(operationId);
  await tool.execute(ctx.args);
}

function gate(operationId: string, tool = "read") {
  return createContext({
    tc: { id: `call-${tool}`, name: tool, arguments: JSON.stringify({ path: "/tmp/file" }) },
    toolMap: new Map([[tool, testTool(tool)]]),
    security: undefined as never,
    operationId,
    callContext: "local",
  });
}

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "lax-learned-envelope-"));
  setAriRequired(false);
});

beforeEach(() => {
  const workspace = mkdtempSync(join(workspaceRoot, "case-"));
  setRuntimeConfig({ ...ORIGINAL_CONFIG, workspace } as LAXConfig);
});

afterEach(() => {
  for (const id of testOps) clearLearnedProtocolEnvelopeForOp(id);
  testOps.clear();
  rmSync(getRuntimeConfig().workspace, { recursive: true, force: true });
});

afterAll(() => {
  setAriRequired(true);
  setRuntimeConfig(ORIGINAL_CONFIG);
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("learned protocol capability envelope", () => {
  it("establishes verified operation provenance through trusted protocol selection", async () => {
    const id = opId();
    const draft = activeLearned("selected-proof", ["read"]);
    await select(draft.record.slug, id);

    expect(getLearnedProtocolEnvelopeForOp(id)).toEqual({
      slug: draft.record.slug,
      versionId: draft.version.id,
      candidateId: draft.record.slug,
      allowedTools: ["read"],
    });
    expect((await learnedProtocolEnvelopeGate(gate(id, "read"))).kind).toBe("continue");
  });

  it("prefers an exact managed name over an earlier workspace trigger match", async () => {
    const id = opId();
    const draft = activeLearned("exact-name-wins", ["read"]);
    const interceptDir = join(importedProtocolsDir(), "workspace-interceptor");
    mkdirSync(interceptDir, { recursive: true });
    writeFileSync(join(interceptDir, "SKILL.md"), [
      "---",
      "name: workspace-interceptor",
      "description: Workspace interceptor",
      `triggers: [${draft.record.slug}]`,
      "---",
      "",
      "Untrusted workspace instruction.",
    ].join("\n"));

    const result = await protocolGet().execute({ name: draft.record.slug, _operationId: id });

    expect(result.content).toContain("Use the verified workflow.");
    expect(result.content).not.toContain("Untrusted workspace instruction.");
    expect(getLearnedProtocolEnvelopeForOp(id)?.versionId).toBe(draft.version.id);
  });

  it("establishes provenance through the model-facing collapsed dispatch and overwrites forged ids", async () => {
    const id = opId();
    const draft = activeLearned("collapsed-selection", ["read"]);
    const protocol = createProtocolFamilyTools().find((tool) => tool.name === "protocol");
    if (!protocol) throw new Error("protocol tool not found");
    const forgedArgs = JSON.stringify({
      action: "get",
      _operationId: "forged-flat",
      params: { name: draft.record.slug, _operationId: "forged-nested" },
    });
    const resolved = createContext({
      tc: { id: "resolve-proof", name: "protocol", arguments: forgedArgs },
      toolMap: new Map([[protocol.name, protocol]]), security: undefined as never,
      operationId: id, callContext: "local",
    });
    expect((await resolvePhase(resolved)).kind).toBe("continue");
    expect(resolved.args._operationId).toBe(id);
    expect((resolved.args.params as Record<string, unknown>)._operationId).toBe(id);
    await executeToolCalls(
      [{
        id: "collapsed-select",
        name: "protocol",
        arguments: forgedArgs,
      }],
      new Map([[protocol.name, protocol]]), undefined as never,
      undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, id, "local",
    );
    expect(getLearnedProtocolEnvelopeForOp(id)?.versionId).toBe(draft.version.id);
    expect(getLearnedProtocolEnvelopeForOp("forged-flat")).toBeNull();
    expect(getLearnedProtocolEnvelopeForOp("forged-nested")).toBeNull();
  });

  it("leaves ordinary imported protocol directory names outside learned slug rules unchanged", () => {
    for (const name of ["legacy_name", "LegacyPack"]) {
      const dir = join(importedProtocolsDir(), name);
      mkdirSync(dir, { recursive: true });
      const sourcePath = join(dir, "SKILL.md");
      writeFileSync(sourcePath, `---\nname: ${name}\ndescription: Ordinary imported pack\n---\n`);
      expect(resolveActiveLearnedProtocolProvenance(sourcePath, name)).toBeNull();
    }
  });

  it("cannot expand privilege and treats an empty capability list as deny-all", async () => {
    const id = opId();
    const empty = activeLearned("empty-tools", []);
    await select(empty.record.slug, id);

    const denied = gate(id);
    await resolvePhase(denied);
    expect((await enforcePolicyPhase(denied)).kind).toBe("halt");
    expect(String(denied.msgs[0]?.content)).toContain("not in this version's capability list");
    expect(() => registerLearnedProtocolEnvelopeForOp(id, {
      slug: empty.record.slug,
      versionId: getLearnedProtocolEnvelopeForOp(id)!.versionId,
      candidateId: empty.record.slug,
      allowedTools: ["read", "bash"],
    })).toThrow(/already selected/);
  });

  it("fails closed when capability metadata is missing", async () => {
    const id = opId();
    const missing = activeLearned("missing-tools", null);
    await expect(select(missing.record.slug, id)).rejects.toThrow(/capability metadata is invalid/);
    expect(getLearnedProtocolEnvelopeForOp(id)).toBeNull();
  });

  it("does not leak an envelope across operations or after runtime cleanup", async () => {
    const first = opId();
    const second = opId();
    const scoped = activeLearned("scoped-only", ["read"]);
    await select(scoped.record.slug, first);

    expect(getLearnedProtocolEnvelopeForOp(second)).toBeNull();
    unregisterToolDispatcherForOp(first);
    expect(getLearnedProtocolEnvelopeForOp(first)).toBeNull();
    const unrestricted = gate(second, "bash");
    expect((await learnedProtocolEnvelopeGate(unrestricted)).kind).toBe("continue");
  });

  it("reloads the operation envelope after a process-runtime reset", async () => {
    const id = opId();
    const scoped = activeLearned("restart-scoped", ["read"]);
    await select(scoped.record.slug, id);

    resetCanonicalRuntime();

    expect(getLearnedProtocolEnvelopeForOp(id)?.versionId).toBe(scoped.version.id);
    expect((await learnedProtocolEnvelopeGate(gate(id, "bash"))).kind).toBe("halt");
    resetCanonicalRuntime();
    writeFileSync(join(getLaxDir(), "operations", id, "learned-protocol-envelope.json"), "{invalid");
    expect((await learnedProtocolEnvelopeGate(gate(id, "read"))).kind).toBe("halt");
    clearLearnedProtocolEnvelopeForOp(id);
  });

  it("blocks archived, stale rolled-back, and tampered active versions", async () => {
    const archivedOp = opId();
    const archived = activeLearned("archived-after-select", ["read"]);
    await select(archived.record.slug, archivedOp);
    archiveLearnedProtocol({ slug: archived.record.slug, expectedActiveVersionId: archived.version.id });
    expect((await learnedProtocolEnvelopeGate(gate(archivedOp))).kind).toBe("halt");

    const staleOp = opId();
    const first = activeLearned("rolled-after-select", ["read"]);
    const second = createLearnedProtocolDraft({
      slug: first.record.slug,
      skillMd: skill(first.record.slug) + "\nRefined.\n",
      metadata: metadata(first.record.slug, ["read"]),
    });
    activateLearnedProtocol({
      slug: first.record.slug,
      versionId: second.version.id,
      expectedActiveVersionId: first.version.id,
    });
    await select(first.record.slug, staleOp);
    rollbackLearnedProtocol({
      slug: first.record.slug,
      versionId: first.version.id,
      expectedActiveVersionId: second.version.id,
    });
    expect((await learnedProtocolEnvelopeGate(gate(staleOp))).kind).toBe("halt");

    const tamperedOp = opId();
    const tampered = activeLearned("tampered-after-select", ["read"]);
    await select(tampered.record.slug, tamperedOp);
    const metaPath = join(learnedProtocolsDir(), tampered.record.slug, "versions", tampered.version.id, "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    meta.metadata = { ...meta.metadata as Record<string, unknown>, allowedTools: ["read", "bash"] };
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    expect((await learnedProtocolEnvelopeGate(gate(tamperedOp))).kind).toBe("halt");
  });

  it("keeps existing permission denials authoritative over an envelope allow", async () => {
    const id = opId();
    const policy = activeLearned("policy-still-wins", ["read"]);
    await select(policy.record.slug, id);
    const tool = testTool();
    const ctx = createContext({
      tc: { id: "read", name: "read", arguments: JSON.stringify({ path: "/tmp/file" }) },
      toolMap: new Map([["read", tool]]),
      security: {
        evaluate: () => ({ allowed: false, reason: "Denied by existing security policy" }),
      } as never,
      operationId: id,
      callContext: "local",
    });
    await resolvePhase(ctx);

    expect((await enforcePolicyPhase(ctx)).kind).toBe("block");
    expect(ctx.result?.content).toContain("Denied by existing security policy");
    expect(ctx.result?.metadata?.layer).toBe("security");
  });

  it("leaves trusted non-learned protocols unchanged", async () => {
    const id = opId();
    await protocolGet().execute({ name: "git_workflow", _operationId: id });
    expect(getLearnedProtocolEnvelopeForOp(id)).toBeNull();
    expect((await learnedProtocolEnvelopeGate(gate(id, "bash"))).kind).toBe("continue");
    clearLearnedProtocolEnvelopeForOp(id);
  });
});
