import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getRuntimeConfig, setRuntimeConfig } from "../config.js";
import type { LAXConfig } from "../types.js";
import { importedProtocolsDir, loadImportedProtocols } from "./loader.js";
import {
  activateLearnedProtocol,
  archiveLearnedProtocol,
  createLearnedProtocolDraft,
  loadLearnedProtocol,
  restoreLearnedProtocol,
  rollbackLearnedProtocol,
} from "./learned-lifecycle.js";

const ORIGINAL_CONFIG = getRuntimeConfig();
let workspace = "";

function skill(name: string, instruction: string): string {
  return `---\nname: ${name}\ndescription: Learned ${name}\n---\n\n# ${name}\n\n${instruction}\n`;
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "lax-learned-protocols-"));
});

beforeEach(() => {
  const current = mkdtempSync(join(workspace, "case-"));
  setRuntimeConfig({ ...ORIGINAL_CONFIG, workspace: current } as LAXConfig);
});

afterEach(() => {
  rmSync(getRuntimeConfig().workspace, { recursive: true, force: true });
});

afterAll(() => {
  setRuntimeConfig(ORIGINAL_CONFIG);
  rmSync(workspace, { recursive: true, force: true });
});

describe("learned protocol lifecycle", () => {
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

    expect(readFileSync(join(importedProtocolsDir(), "versioned", "SKILL.md"), "utf8")).toBe(firstBody);
    expect(loadLearnedProtocol("versioned").activeVersionId).toBe(first.version.id);
  });

  it("fails closed when immutable version content no longer matches its hash", () => {
    const draft = createLearnedProtocolDraft({ slug: "tamper-check", skillMd: skill("tamper-check", "Trusted") });
    const versionPath = join(importedProtocolsDir(), "tamper-check", "versions", draft.version.id, "SKILL.md");
    writeFileSync(versionPath, skill("tamper-check", "Tampered"));

    expect(() => activateLearnedProtocol({
      slug: "tamper-check",
      versionId: draft.version.id,
      expectedActiveVersionId: null,
    })).toThrow(/hash mismatch/);
    expect(existsSync(join(importedProtocolsDir(), "tamper-check", "SKILL.md"))).toBe(false);
  });

  it("rejects traversal, symbolic links, and unmanaged directory collisions", () => {
    expect(() => createLearnedProtocolDraft({ slug: "../escape", skillMd: skill("escape", "No") })).toThrow(/Invalid/);

    mkdirSync(importedProtocolsDir(), { recursive: true });
    mkdirSync(join(importedProtocolsDir(), "occupied"));
    expect(() => createLearnedProtocolDraft({ slug: "occupied", skillMd: skill("occupied", "No") })).toThrow(/collision/);

    const outside = join(getRuntimeConfig().workspace, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(importedProtocolsDir(), "linked"));
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
    const versionDir = join(importedProtocolsDir(), "history", "versions", draft.version.id);
    const bodyBefore = readFileSync(join(versionDir, "SKILL.md"), "utf8");
    const metaBefore = readFileSync(join(versionDir, "meta.json"), "utf8");
    const path = join(importedProtocolsDir(), "history", "learned.json");
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
    const path = join(importedProtocolsDir(), "history-integrity", "learned.json");
    const record = JSON.parse(readFileSync(path, "utf8")) as { activationHistory: Array<Record<string, unknown>> };
    record.activationHistory.push({
      ...record.activationHistory[0], previousVersionId: "00000000-0000-0000-0000-000000000000", timestamp: 100,
    });
    writeFileSync(path, JSON.stringify(record, null, 2));

    expect(() => loadLearnedProtocol("history-integrity")).toThrow(/activation history/);
  });
});
