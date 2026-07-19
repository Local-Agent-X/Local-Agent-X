import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const opsBySession = new Map<string, string[]>();
const tasksByOpId = new Map<string, string>();

vi.mock("../src/ops/session-bridge.js", () => ({
  listOpsForSession: vi.fn((sessionId: string) => opsBySession.get(sessionId) ?? []),
  getOpTask: vi.fn((opId: string) => tasksByOpId.get(opId) ?? ""),
}));

import { augmentSystemPrompt } from "../src/routes/chat/system-prompt-augmentations.js";
import { ThreatEngine } from "../src/threat/threat-engine.js";
import { measurePromptSection } from "../src/prompt-telemetry.js";

const dataDir = mkdtempSync(join(tmpdir(), "lax-syspromp-test-"));

function promptTarget(systemPrompt: string) {
  return {
    systemPrompt,
    renderedPromptSections: systemPrompt ? [{
      id: "base",
      label: "Base",
      type: "static" as const,
      policy: "required" as const,
      text: systemPrompt,
      measurement: measurePromptSection("base", "static", systemPrompt),
    }] : [],
  };
}

beforeEach(() => {
  opsBySession.clear();
  tasksByOpId.clear();
  vi.clearAllMocks();
});

describe("augmentSystemPrompt", () => {
  it("appends the threat-engine canary block so checkOutput has tokens to match", async () => {
    const prepared = promptTarget("Base system prompt.");
    const te = new ThreatEngine(dataDir, "sess-1");
    await augmentSystemPrompt(prepared, te, "sess-1");

    expect(prepared.systemPrompt.startsWith("Base system prompt.")).toBe(true);
    // canary block contains the marker labels plus our unique token prefixes.
    expect(prepared.systemPrompt).toContain("INTERNAL REFERENCE");
    expect(prepared.systemPrompt).toContain("CANARY-");
    expect(prepared.systemPrompt).toContain("SENTINEL-");
    expect(prepared.systemPrompt).toContain("TRIPWIRE-");
    expect(prepared.renderedPromptSections.map((section) => section.text).join(""))
      .toBe(prepared.systemPrompt);
    expect(prepared.renderedPromptSections.at(-1)).toMatchObject({
      id: "security-canary",
      policy: "required",
    });
  });

  it("the seeded canary in the prompt actually matches checkOutput — closes the false-negative loop", async () => {
    const prepared = promptTarget("");
    const te = new ThreatEngine(dataDir, "sess-2");
    await augmentSystemPrompt(prepared, te, "sess-2");

    // Pull a canary token straight out of the prompt the model will see,
    // then feed it back through checkOutput. If the canary in the prompt
    // matches what checkOutput watches for, this trips. Pre-fix this never
    // tripped because the prompt sent to the model had no canary at all.
    const m = prepared.systemPrompt.match(/CANARY-[a-f0-9]+-ALPHA/);
    expect(m).not.toBeNull();
    expect(te.checkOutput(m![0])).not.toBeNull();
  });

  it("adds parallel-worker context block when ops are active for the session", async () => {
    opsBySession.set("sess-3", ["op-a", "op-b"]);
    tasksByOpId.set("op-a", "build landing page");
    tasksByOpId.set("op-b", "scrape competitor pricing");

    const prepared = promptTarget("Base.");
    const te = new ThreatEngine(dataDir, "sess-3");
    await augmentSystemPrompt(prepared, te, "sess-3");

    expect(prepared.systemPrompt).toContain("[PARALLEL CONTEXT — 2 background workers active]");
    expect(prepared.systemPrompt).toContain("build landing page");
    expect(prepared.systemPrompt).toContain("scrape competitor pricing");
    expect(prepared.renderedPromptSections.map((section) => section.text).join(""))
      .toBe(prepared.systemPrompt);
    expect(prepared.renderedPromptSections.at(-1)).toMatchObject({
      id: "parallel-context",
      policy: "required",
    });
  });

  it("singularizes the parallel-context header when only one worker is active", async () => {
    opsBySession.set("sess-4", ["op-only"]);
    tasksByOpId.set("op-only", "single task");

    const prepared = promptTarget("Base.");
    const te = new ThreatEngine(dataDir, "sess-4");
    await augmentSystemPrompt(prepared, te, "sess-4");

    expect(prepared.systemPrompt).toContain("[PARALLEL CONTEXT — 1 background worker active]");
  });

  it("does not add a parallel-context block when no workers are active", async () => {
    const prepared = promptTarget("Base.");
    const te = new ThreatEngine(dataDir, "sess-5");
    await augmentSystemPrompt(prepared, te, "sess-5");

    expect(prepared.systemPrompt).not.toContain("PARALLEL CONTEXT");
    // Canary block still present — security is non-optional.
    expect(prepared.systemPrompt).toContain("CANARY-");
  });
});
