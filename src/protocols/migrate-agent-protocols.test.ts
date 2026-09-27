import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Protocol } from "./types.js";

function protocol(name: string, over: Partial<Protocol> = {}): Protocol {
  return {
    name,
    description: `Run the ${name} workflow`,
    triggers: [name.replace(/_/g, " ")],
    steps: [],
    rules: [],
    learnablePreferences: [],
    ...over,
  };
}

const CATALOG: Protocol[] = [
  protocol("agent_refactor_flow", {
    body: "## Steps\n1. Rename the module.",
    source: { type: "custom", authoredBy: "agent", authoredAt: 1_700_000_000_000, authoredFromSession: "chat-1" },
  }),
  protocol("Agent Steps-Only", {
    steps: [{ id: "a", instruction: "Open the dashboard" }, { id: "b", instruction: "Export the CSV" }],
    rules: ["Never export PII"],
    source: { type: "custom", authoredBy: "agent", authoredAt: 1_700_000_000_000 },
  }),
  protocol("agent_empty", { source: { type: "custom", authoredBy: "agent" } }),
  protocol("user_flow", { body: "mine", source: { type: "custom", authoredBy: "user", authoredAt: 1 } }),
  protocol("legacy_unknown", { body: "who knows" }),
];

describe("agent-authored catalog migration", () => {
  const originalDataDir = process.env.LAX_DATA_DIR;
  let root = "";
  let customPath = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lax-migrate-agent-protocols-"));
    process.env.LAX_DATA_DIR = join(root, "data");
    customPath = join(root, "workspace", "protocols", "custom.json");
    mkdirSync(join(root, "workspace", "protocols"), { recursive: true });
    writeFileSync(customPath, JSON.stringify(CATALOG, null, 2));
    vi.resetModules();
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.LAX_DATA_DIR;
    else process.env.LAX_DATA_DIR = originalDataDir;
    rmSync(root, { recursive: true, force: true });
  });

  async function system() {
    const config = await import("../config.js");
    config.setRuntimeConfig({ ...config.getRuntimeConfig(), workspace: join(root, "workspace") });
    const migration = await import("./migrate-agent-protocols.js");
    const learner = (await import("../cognition/cross-session-learning/index.js")).default;
    const { getAllProtocols } = await import("./index.js");
    return { migration, learner, getAllProtocols };
  }

  it("plans without writing anything", async () => {
    const { migration } = await system();
    const before = readFileSync(customPath, "utf8");
    const plan = migration.planAgentProtocolMigration();
    expect(plan.move).toEqual([
      { from: "agent_refactor_flow", to: "agent_refactor_flow" },
      { from: "Agent Steps-Only", to: "agent_steps_only" },
    ]);
    expect(plan.keep).toEqual(["user_flow", "legacy_unknown"]);
    expect(plan.unmovable).toEqual([{ name: "agent_empty", reason: "no body, steps, or rules" }]);
    expect(readFileSync(customPath, "utf8")).toBe(before);
  });

  it("moves agent entries into unverified learned drafts, keeps the rest, and writes a backup first", async () => {
    const { migration, learner, getAllProtocols } = await system();
    const original = readFileSync(customPath, "utf8");
    const evidence = vi.fn((sessionId: string) => (sessionId === "chat-1" ? ["browser", "read", "browser"] : []));

    const report = await migration.migrateAgentAuthoredProtocols({ now: 1_800_000_000_000, toolEvidenceForSession: evidence });

    expect(report.backupPath).toBe(`${customPath}.pre-learned-migration-1800000000000.bak`);
    expect(readFileSync(report.backupPath!, "utf8")).toBe(original);
    expect(report.migrated.map((m) => m.from)).toEqual(["agent_refactor_flow", "Agent Steps-Only"]);
    expect(evidence).toHaveBeenCalledWith("chat-1");

    const remaining = (JSON.parse(readFileSync(customPath, "utf8")) as Protocol[]).map((p) => p.name);
    expect(remaining).toEqual(["agent_empty", "user_flow", "legacy_unknown"]);

    const candidates = learner.getCandidates();
    expect(candidates.map((c) => c.suggestion.name).sort()).toEqual(["agent_refactor_flow", "agent_steps_only"]);
    for (const candidate of candidates) {
      expect(candidate).toMatchObject({ evidenceClass: "reviewed-procedure", state: "candidate", confidence: 0 });
      expect(candidate.evidence.proposals?.every((p) => p.outcome === "unverified")).toBe(true);
    }
    const refactor = candidates.find((c) => c.suggestion.name === "agent_refactor_flow")!;
    expect(refactor.evidence.proposals?.[0]).toMatchObject({ sessionId: "chat-1", timestamp: 1_700_000_000_000 });

    const learned = readdirSync(join(root, "data", "protocols", "learned"));
    expect(learned.sort()).toEqual(candidates.map((c) => c.id).sort());
    const served = getAllProtocols().map((p) => p.name);
    for (const candidate of candidates) expect(served).not.toContain(candidate.id);
    expect(served).toEqual(expect.arrayContaining(["user_flow", "legacy_unknown"]));
    expect(served).not.toContain("agent_refactor_flow");
  });

  it("is a no-op, with no backup, when nothing is agent-authored", async () => {
    writeFileSync(customPath, JSON.stringify([CATALOG[3], CATALOG[4]], null, 2));
    const { migration } = await system();
    const report = await migration.migrateAgentAuthoredProtocols({ toolEvidenceForSession: () => [] });
    expect(report).toMatchObject({ backupPath: null, migrated: [] });
    expect(readdirSync(join(root, "workspace", "protocols"))).toEqual(["custom.json"]);
  });

  it("refuses to rewrite a custom.json it could not read cleanly", async () => {
    writeFileSync(customPath, "{ not json");
    const { migration } = await system();
    await expect(migration.migrateAgentAuthoredProtocols({ toolEvidenceForSession: () => [] })).rejects.toThrow(/could not be read/);
    expect(readFileSync(customPath, "utf8")).toBe("{ not json");
    expect(existsSync(join(root, "data", "protocols", "learned"))).toBe(false);
  });
});
