import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getRuntimeConfig, setRuntimeConfig } from "../config.js";
import type { LAXConfig } from "../types.js";
import type { LearnedCandidate } from "../cognition/cross-session-learning/types.js";
import { importedProtocolsDir, loadImportedProtocols } from "./loader.js";
import { draftLearnedCandidate, renderLearnedCandidateSkill } from "./learned-drafting.js";
import { activateLearnedProtocol, createLearnedProtocolDraft, loadLearnedProtocol } from "./learned-lifecycle.js";
import { parseSkillMd } from "./skill-md-parser.js";

const ORIGINAL_CONFIG = getRuntimeConfig();
let workspace = "";

function workflowCandidate(): LearnedCandidate {
  return {
    id: "learned-0123456789abcdefabcd",
    state: "candidate",
    confidence: 0.8,
    suggestion: {
      type: "mission",
      name: "workflow-coding-read-file-write-file-run-tests",
      description: "Reusable workflow candidate",
      config: {
        sequence: ["read_file -> write_file -> run_tests"],
        patternType: "workflow",
        occurrences: 4,
      },
    },
    evidence: {
      patternType: "workflow",
      description: "Workflow \"coding:read_file -> write_file -> run_tests\" completed cleanly 3/4 times",
      occurrences: 4,
      lastSeen: 1_750_000_000_000,
      examples: ["read_file -> write_file -> run_tests"],
      outcomeStats: {
        clean: 3,
        partial: 1,
        aborted: 0,
        successRate: 0.75,
        weightedSuccessRate: 0.8,
        distinctSessions: 3,
      },
    },
    createdAt: 1_750_000_000_000,
    updatedAt: 1_750_000_000_000,
    transitions: [],
  };
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "lax-learned-drafting-"));
});

beforeEach(() => {
  setRuntimeConfig({ ...ORIGINAL_CONFIG, workspace: mkdtempSync(join(workspace, "case-")) } as LAXConfig);
});

afterEach(() => {
  rmSync(getRuntimeConfig().workspace, { recursive: true, force: true });
});

afterAll(() => {
  setRuntimeConfig(ORIGINAL_CONFIG);
  rmSync(workspace, { recursive: true, force: true });
});

describe("learned protocol drafting", () => {
  it("rejects non-workflow, unproven, and malformed candidates", () => {
    const nonWorkflow = workflowCandidate();
    nonWorkflow.evidence.patternType = "task";
    expect(() => draftLearnedCandidate(nonWorkflow)).toThrow(/Only workflow/);

    const unproven = workflowCandidate();
    unproven.evidence.outcomeStats = { clean: 2, partial: 2, aborted: 0, successRate: 0.5, weightedSuccessRate: 0.5, distinctSessions: 1 };
    unproven.confidence = 0.5;
    expect(() => draftLearnedCandidate(unproven)).toThrow(/not outcome-proven/);

    const malformed = workflowCandidate();
    malformed.suggestion.config.sequence = ["read_file -> ../shell"];
    malformed.evidence.examples = ["read_file -> ../shell"];
    expect(() => draftLearnedCandidate(malformed)).toThrow(/malformed tool identity/);
  });

  it("renders the evidence-backed tool sequence in exact order", () => {
    const rendered = renderLearnedCandidateSkill(workflowCandidate());
    const read = rendered.indexOf("1. Use `read_file`");
    const write = rendered.indexOf("2. Use `write_file`");
    const test = rendered.indexOf("3. Use `run_tests`");

    expect(read).toBeGreaterThan(-1);
    expect(read).toBeLessThan(write);
    expect(write).toBeLessThan(test);
    expect(rendered).toContain("when-to-use: coding workflow using read_file then write_file then run_tests");
    expect(rendered).toContain("category: coding");
    const parsed = parseSkillMd(rendered, { source: { type: "imported" } });
    expect(parsed).toMatchObject({
      description: "Outcome-proven coding workflow using read_file then write_file then run_tests",
      triggers: ["coding workflow using read_file then write_file then run_tests"],
      category: "coding",
      allowedTools: ["read_file", "write_file", "run_tests"],
    });
  });

  it("stores exact candidate provenance and allowed tool identities", () => {
    const candidate = workflowCandidate();
    const drafted = draftLearnedCandidate(candidate);
    const metadata = drafted.version.metadata;

    expect(drafted.slug).toBe(candidate.id);
    expect(metadata).toMatchObject({
      candidateId: candidate.id,
      evidenceSnapshot: candidate.evidence,
      confidence: candidate.confidence,
      allowedTools: ["read_file", "write_file", "run_tests"],
      toolSequence: ["read_file", "write_file", "run_tests"],
    });
  });

  it("is idempotent when the candidate evidence is unchanged", () => {
    const candidate = workflowCandidate();
    const first = draftLearnedCandidate(candidate);
    const repeated = draftLearnedCandidate(structuredClone(candidate));

    expect(first.created).toBe(true);
    expect(repeated).toEqual({ slug: first.slug, version: first.version, created: false });
    expect(loadLearnedProtocol(first.slug).versions).toHaveLength(1);
  });

  it("creates a new immutable version when evidence becomes stronger", () => {
    const candidate = workflowCandidate();
    const first = draftLearnedCandidate(candidate);
    const stronger = workflowCandidate();
    stronger.evidence.occurrences = 5;
    stronger.evidence.description = "Workflow \"coding:read_file -> write_file -> run_tests\" completed cleanly 4/5 times";
    stronger.evidence.outcomeStats = { clean: 4, partial: 1, aborted: 0, successRate: 0.8, weightedSuccessRate: 0.85, distinctSessions: 4 };
    stronger.suggestion.config.occurrences = 5;
    stronger.confidence = 0.85;

    const second = draftLearnedCandidate(stronger);

    expect(second.created).toBe(true);
    expect(second.version.id).not.toBe(first.version.id);
    expect(loadLearnedProtocol(first.slug).versions).toHaveLength(2);
  });

  it("allows active refinements only for the matching managed candidate history", () => {
    const unmanaged = workflowCandidate();
    unmanaged.state = "active";
    expect(() => draftLearnedCandidate(unmanaged)).toThrow(/no managed protocol history/);

    createLearnedProtocolDraft({
      slug: unmanaged.id,
      skillMd: renderLearnedCandidateSkill({ ...unmanaged, state: "candidate" }),
      metadata: { candidateId: "learned-ffffffffffffffffffff" },
    });
    expect(() => draftLearnedCandidate(unmanaged)).toThrow(/does not match its managed candidate history/);

    const original = workflowCandidate();
    original.id = "learned-0123456789abcdefabce";
    const first = draftLearnedCandidate(original);
    activateLearnedProtocol({ slug: first.slug, versionId: first.version.id, expectedActiveVersionId: null });
    const stronger = workflowCandidate();
    stronger.id = original.id;
    stronger.state = "active";
    stronger.evidence.occurrences = 5;
    stronger.evidence.description = "Workflow \"coding:read_file -> write_file -> run_tests\" completed cleanly 4/5 times";
    stronger.evidence.outcomeStats = { clean: 4, partial: 1, aborted: 0, successRate: 0.8, weightedSuccessRate: 0.85, distinctSessions: 4 };
    stronger.suggestion.config.occurrences = 5;
    stronger.confidence = 0.85;

    expect(draftLearnedCandidate(stronger).created).toBe(true);
  });

  it("keeps drafted candidates undiscoverable until another layer activates them", () => {
    const drafted = draftLearnedCandidate(workflowCandidate());

    expect(loadImportedProtocols().map((protocol) => protocol.name)).not.toContain(drafted.slug);
    const immutableBody = readFileSync(join(importedProtocolsDir(), drafted.slug, "versions", drafted.version.id, "SKILL.md"), "utf8");
    expect(immutableBody).toContain("# Learned workflow");
  });
});
