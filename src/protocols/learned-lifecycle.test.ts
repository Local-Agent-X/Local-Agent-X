import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { getRuntimeConfig, setRuntimeConfig } from "../config.js";
import type { LAXConfig } from "../types.js";
import { importedProtocolsDir, learnedProtocolsDir, loadImportedProtocols } from "./loader.js";
import {
  activateLearnedProtocol,
  archiveLearnedProtocol,
  createLearnedProtocolDraft,
  loadLearnedProtocol,
  restoreLearnedProtocol,
  rollbackLearnedProtocol,
} from "./learned-lifecycle.js";

const ORIGINAL_CONFIG = getRuntimeConfig();
const ORIGINAL_DATA_DIR = process.env.LAX_DATA_DIR;
let workspace = "";

function skill(name: string, instruction: string): string {
  return `---\nname: ${name}\ndescription: Learned ${name}\n---\n\n# ${name}\n\n${instruction}\n`;
}

function runWorker(script: string, args: string[], dataDir: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, ["--import=tsx", script, ...args], {
      cwd: process.cwd(), env: { ...process.env, LAX_DATA_DIR: dataDir }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolveChild({ code, stdout, stderr }));
  });
}

function writeLifecycleWorker(dir: string): string {
  const worker = join(dir, "lifecycle-worker.mjs");
  const lifecycleUrl = pathToFileURL(resolve("src/protocols/learned-lifecycle.ts")).href;
  const sqliteUrl = pathToFileURL(resolve("node_modules/better-sqlite3/lib/index.js")).href;
  writeFileSync(worker, `
import { existsSync } from "node:fs";
import Database from ${JSON.stringify(sqliteUrl)};
import { createLearnedProtocolDraft, activateLearnedProtocol } from ${JSON.stringify(lifecycleUrl)};
const [mode, data, gate] = process.argv.slice(2);
while (gate && !existsSync(gate)) await new Promise((done) => setTimeout(done, 5));
const input = JSON.parse(data);
if (mode === "draft") {
  const result = createLearnedProtocolDraft(input);
  process.stdout.write(result.version.id);
  process.exit(0);
}
if (mode === "activate") {
  try {
    activateLearnedProtocol(input);
    process.stdout.write("winner");
    process.exit(0);
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
if (mode === "crash") {
  const db = new Database(input.lockPath);
  db.exec("BEGIN IMMEDIATE");
  process.stdout.write("locked");
  process.exit(23);
}
process.exit(3);
`, "utf8");
  return worker;
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "lax-learned-protocols-"));
});

beforeEach(() => {
  const current = mkdtempSync(join(workspace, "case-"));
  process.env.LAX_DATA_DIR = current;
  setRuntimeConfig({ ...ORIGINAL_CONFIG, workspace: current } as LAXConfig);
});

afterEach(() => {
  rmSync(getRuntimeConfig().workspace, { recursive: true, force: true });
});

afterAll(() => {
  setRuntimeConfig(ORIGINAL_CONFIG);
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = ORIGINAL_DATA_DIR;
  rmSync(workspace, { recursive: true, force: true });
});

describe("learned protocol lifecycle", () => {
  it("loads ordinary user imports but ignores workspace records carrying a managed marker", () => {
    const ordinaryDir = join(importedProtocolsDir(), "ordinary-user-pack");
    mkdirSync(ordinaryDir, { recursive: true });
    writeFileSync(join(ordinaryDir, "SKILL.md"), skill("ordinary-user-pack", "User instruction"));

    for (const [name, contents] of [
      ["learned-aaaaaaaaaaaaaaaaaaaa", skill("learned-aaaaaaaaaaaaaaaaaaaa", "Workspace sentinel")],
      ["legacy-trigger-record", "---\nname: legacy-trigger-record\ndescription: Legacy marker\ntriggers: [unique-forged-trigger]\n---\nWorkspace sentinel\n"],
    ]) {
      const dir = join(importedProtocolsDir(), name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), contents);
      writeFileSync(join(dir, "learned.json"), JSON.stringify({ schemaVersion: 1, slug: name, state: "active" }));
    }

    const loaded = loadImportedProtocols();
    expect(loaded.find((protocol) => protocol.name === "ordinary-user-pack")?.body).toContain("User instruction");
    expect(loaded.map((protocol) => protocol.name)).not.toContain("learned-aaaaaaaaaaaaaaaaaaaa");
    expect(loaded.map((protocol) => protocol.name)).not.toContain("legacy-trigger-record");
  });

  it("keeps user imports while giving the machine-local managed tier final precedence", () => {
    expect(learnedProtocolsDir()).toBe(join(process.env.LAX_DATA_DIR!, "protocols", "learned"));
    const userDir = join(importedProtocolsDir(), "precedence-check");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "SKILL.md"), skill("precedence-check", "Workspace instruction"));
    expect(loadImportedProtocols().find((protocol) => protocol.name === "precedence-check")?.body)
      .toContain("Workspace instruction");

    const managed = createLearnedProtocolDraft({
      slug: "precedence-check",
      skillMd: skill("precedence-check", "Managed instruction"),
    });
    activateLearnedProtocol({
      slug: "precedence-check",
      versionId: managed.version.id,
      expectedActiveVersionId: null,
    });

    const loaded = loadImportedProtocols().filter((protocol) => protocol.name === "precedence-check");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].body).toContain("Managed instruction");
  });

  it("keeps drafts undiscoverable and materializes only the activated version", () => {
    const draft = createLearnedProtocolDraft({ slug: "quiet-draft", skillMd: skill("quiet-draft", "First instruction") });
    expect(loadImportedProtocols().map((protocol) => protocol.name)).not.toContain("quiet-draft");

    activateLearnedProtocol({
      slug: "quiet-draft",
      versionId: draft.version.id,
      expectedActiveVersionId: null,
    });

    const loaded = loadImportedProtocols().find((protocol) => protocol.name === "quiet-draft");
    expect(loaded?.body).toContain("First instruction");
  });

  it("archives and restores the same verified active version", () => {
    const draft = createLearnedProtocolDraft({ slug: "restorable", skillMd: skill("restorable", "Keep this exact body") });
    activateLearnedProtocol({ slug: "restorable", versionId: draft.version.id, expectedActiveVersionId: null });

    archiveLearnedProtocol({ slug: "restorable", expectedActiveVersionId: draft.version.id });
    expect(loadImportedProtocols().map((protocol) => protocol.name)).not.toContain("restorable");

    restoreLearnedProtocol({ slug: "restorable", expectedActiveVersionId: draft.version.id });
    expect(loadImportedProtocols().find((protocol) => protocol.name === "restorable")?.body).toContain("Keep this exact body");
  });

  it("rolls back to the exact immutable prior version", () => {
    const firstBody = skill("versioned", "Original behavior");
    const secondBody = skill("versioned", "Replacement behavior");
    const first = createLearnedProtocolDraft({ slug: "versioned", skillMd: firstBody });
    activateLearnedProtocol({ slug: "versioned", versionId: first.version.id, expectedActiveVersionId: null });
    const second = createLearnedProtocolDraft({ slug: "versioned", skillMd: secondBody });
    activateLearnedProtocol({ slug: "versioned", versionId: second.version.id, expectedActiveVersionId: first.version.id });

    rollbackLearnedProtocol({ slug: "versioned", versionId: first.version.id, expectedActiveVersionId: second.version.id });

    expect(readFileSync(join(learnedProtocolsDir(), "versioned", "SKILL.md"), "utf8")).toBe(firstBody);
    expect(loadLearnedProtocol("versioned").activeVersionId).toBe(first.version.id);
  });

  it("fails closed when immutable version content no longer matches its hash", () => {
    const draft = createLearnedProtocolDraft({ slug: "tamper-check", skillMd: skill("tamper-check", "Trusted") });
    const versionPath = join(learnedProtocolsDir(), "tamper-check", "versions", draft.version.id, "SKILL.md");
    writeFileSync(versionPath, skill("tamper-check", "Tampered"));

    expect(() => activateLearnedProtocol({
      slug: "tamper-check",
      versionId: draft.version.id,
      expectedActiveVersionId: null,
    })).toThrow(/hash mismatch/);
    expect(existsSync(join(learnedProtocolsDir(), "tamper-check", "SKILL.md"))).toBe(false);
  });

  it("rejects traversal, symbolic links, and unmanaged directory collisions", () => {
    expect(() => createLearnedProtocolDraft({ slug: "../escape", skillMd: skill("escape", "No") })).toThrow(/Invalid/);

    mkdirSync(learnedProtocolsDir(), { recursive: true });
    mkdirSync(join(learnedProtocolsDir(), "occupied"));
    expect(() => createLearnedProtocolDraft({ slug: "occupied", skillMd: skill("occupied", "No") })).toThrow(/collision/);

    const outside = join(getRuntimeConfig().workspace, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(learnedProtocolsDir(), "linked"), process.platform === "win32" ? "junction" : "dir");
    expect(() => createLearnedProtocolDraft({ slug: "linked", skillMd: skill("linked", "No") })).toThrow(/symbolic link/);
  });

  it("persists lifecycle state across fresh disk reads and rejects stale mutations", () => {
    const draft = createLearnedProtocolDraft({
      slug: "durable",
      skillMd: skill("durable", "Persist me"),
      metadata: { evidenceId: "evidence-1" },
    });
    activateLearnedProtocol({ slug: "durable", versionId: draft.version.id, expectedActiveVersionId: null });

    const reloaded = loadLearnedProtocol("durable");
    expect(reloaded).toMatchObject({ state: "active", activeVersionId: draft.version.id });
    expect(reloaded.versions[0].metadata).toEqual({ evidenceId: "evidence-1" });
    expect(() => archiveLearnedProtocol({ slug: "durable", expectedActiveVersionId: null })).toThrow(/version changed/);
  });

  it("migrates old records in memory and persists bounded activation reasons without changing versions", () => {
    const draft = createLearnedProtocolDraft({ slug: "history", skillMd: skill("history", "Immutable body"), metadata: { proof: "fixed" } });
    const versionDir = join(learnedProtocolsDir(), "history", "versions", draft.version.id);
    const bodyBefore = readFileSync(join(versionDir, "SKILL.md"), "utf8");
    const metaBefore = readFileSync(join(versionDir, "meta.json"), "utf8");
    const path = join(learnedProtocolsDir(), "history", "learned.json");
    const old = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    delete old.activationHistory;
    writeFileSync(path, JSON.stringify(old, null, 2));

    expect(loadLearnedProtocol("history").activationHistory).toBeUndefined();
    activateLearnedProtocol({
      slug: "history", versionId: draft.version.id, expectedActiveVersionId: null,
      reason: "Automatic initial activation", timestamp: 123,
    });

    const reloaded = loadLearnedProtocol("history");
    expect(reloaded.activationHistory).toEqual([{
      kind: "activate", versionId: draft.version.id, previousVersionId: null,
      reason: "Automatic initial activation", timestamp: 123,
    }]);
    expect(readFileSync(join(versionDir, "SKILL.md"), "utf8")).toBe(bodyBefore);
    expect(readFileSync(join(versionDir, "meta.json"), "utf8")).toBe(metaBefore);
  });

  it("fails closed on activation history with broken version linkage or ordering", () => {
    const draft = createLearnedProtocolDraft({ slug: "history-integrity", skillMd: skill("history-integrity", "Trusted") });
    activateLearnedProtocol({
      slug: "history-integrity", versionId: draft.version.id, expectedActiveVersionId: null,
      timestamp: 200,
    });
    const path = join(learnedProtocolsDir(), "history-integrity", "learned.json");
    const record = JSON.parse(readFileSync(path, "utf8")) as { activationHistory: Array<Record<string, unknown>> };
    record.activationHistory.push({
      ...record.activationHistory[0], previousVersionId: "00000000-0000-0000-0000-000000000000", timestamp: 100,
    });
    writeFileSync(path, JSON.stringify(record, null, 2));

    expect(() => loadLearnedProtocol("history-integrity")).toThrow(/activation history/);
  });

  it("deduplicates exact drafts across concurrent processes", async () => {
    const worker = writeLifecycleWorker(workspace);
    const gate = join(getRuntimeConfig().workspace, "draft-start");
    const first = { slug: "same-draft", skillMd: skill("same-draft", "Exact body"), metadata: { alpha: 1, beta: "two" } };
    const second = { ...first, metadata: { beta: "two", alpha: 1 } };
    const runs = [first, second].map((input) =>
      runWorker(worker, ["draft", JSON.stringify(input), gate], process.env.LAX_DATA_DIR!));
    writeFileSync(gate, "go", "utf8");
    const results = await Promise.all(runs);

    expect(results.map((result) => result.code)).toEqual([0, 0]);
    expect(results[0].stdout).toBe(results[1].stdout);
    const record = loadLearnedProtocol("same-draft");
    expect(record.versions).toHaveLength(1);
    const versions = join(learnedProtocolsDir(), "same-draft", "versions");
    expect(readFileSync(join(versions, record.versions[0].id, "SKILL.md"), "utf8")).toBe(first.skillMd);
  }, 20_000);

  it("preserves distinct concurrent drafts in the canonical record", async () => {
    const worker = writeLifecycleWorker(workspace);
    const gate = join(getRuntimeConfig().workspace, "distinct-start");
    const runs = ["First stronger body", "Second stronger body"].map((instruction, index) =>
      runWorker(worker, ["draft", JSON.stringify({
        slug: "distinct-drafts", skillMd: skill("distinct-drafts", instruction), metadata: { strength: index + 1 },
      }), gate], process.env.LAX_DATA_DIR!));
    writeFileSync(gate, "go", "utf8");
    const results = await Promise.all(runs);

    expect(results.map((result) => result.code)).toEqual([0, 0]);
    expect(new Set(results.map((result) => result.stdout)).size).toBe(2);
    expect(loadLearnedProtocol("distinct-drafts").versions).toHaveLength(2);
  }, 20_000);

  it("allows one same-expected activation winner without corrupting history", async () => {
    const first = createLearnedProtocolDraft({ slug: "activation-race", skillMd: skill("activation-race", "First") });
    const second = createLearnedProtocolDraft({ slug: "activation-race", skillMd: skill("activation-race", "Second") });
    const worker = writeLifecycleWorker(workspace);
    const gate = join(getRuntimeConfig().workspace, "activation-start");
    const runs = [first.version.id, second.version.id].map((versionId) =>
      runWorker(worker, ["activate", JSON.stringify({
        slug: "activation-race", versionId, expectedActiveVersionId: null,
      }), gate], process.env.LAX_DATA_DIR!));
    writeFileSync(gate, "go", "utf8");
    const results = await Promise.all(runs);

    expect(results.filter((result) => result.code === 0)).toHaveLength(1);
    expect(results.filter((result) => result.code === 2)).toHaveLength(1);
    expect(results.find((result) => result.code === 2)?.stderr).toMatch(/version changed/);
    const record = loadLearnedProtocol("activation-race");
    expect(record.activationHistory).toHaveLength(1);
    expect(record.activationHistory?.[0].versionId).toBe(record.activeVersionId);
    const active = record.versions.find((version) => version.id === record.activeVersionId)!;
    expect(readFileSync(join(learnedProtocolsDir(), "activation-race", "SKILL.md"), "utf8"))
      .toBe(readFileSync(join(learnedProtocolsDir(), "activation-race", "versions", active.id, "SKILL.md"), "utf8"));
  }, 20_000);

  it("releases the OS mutex when its owning process crashes", async () => {
    const worker = writeLifecycleWorker(workspace);
    const lockPath = join(process.env.LAX_DATA_DIR!, "protocols", "learned-lifecycle.lock.sqlite");
    mkdirSync(join(process.env.LAX_DATA_DIR!, "protocols"), { recursive: true });
    const crashed = await runWorker(worker, ["crash", JSON.stringify({ lockPath }), ""], process.env.LAX_DATA_DIR!);
    expect(crashed).toEqual({ code: 23, stdout: "locked", stderr: "" });

    const started = Date.now();
    createLearnedProtocolDraft({ slug: "after-crash", skillMd: skill("after-crash", "Recovered") });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(loadLearnedProtocol("after-crash").versions).toHaveLength(1);
  }, 10_000);

  it("executes no lifecycle mutation when the OS mutex cannot be acquired", () => {
    const lockPath = join(process.env.LAX_DATA_DIR!, "protocols", "learned-lifecycle.lock.sqlite");
    mkdirSync(join(process.env.LAX_DATA_DIR!, "protocols"), { recursive: true });
    const blocker = new Database(lockPath);
    blocker.exec("BEGIN IMMEDIATE");
    try {
      expect(() => createLearnedProtocolDraft({
        slug: "blocked-draft", skillMd: skill("blocked-draft", "Must not be written"),
      })).toThrow();
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
    expect(existsSync(join(learnedProtocolsDir(), "blocked-draft"))).toBe(false);
  }, 10_000);
});
