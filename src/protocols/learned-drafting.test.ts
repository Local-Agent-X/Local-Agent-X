import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getRuntimeConfig, setRuntimeConfig } from "../config.js";
import type { LAXConfig } from "../types.js";
import type { LearnedCandidate } from "../cognition/cross-session-learning/types.js";
import {
  deriveCandidateId,
  TERMINAL_TELEMETRY_IDENTITY,
  WORKFLOW_TACTIC_IDENTITY,
} from "../cognition/cross-session-learning/types.js";
import { learnedProtocolsDir, loadImportedProtocols } from "./loader.js";
import { draftLearnedCandidate, renderLearnedCandidateSkill } from "./learned-drafting.js";
import { activateLearnedProtocol, createLearnedProtocolDraft, loadLearnedProtocol } from "./learned-lifecycle.js";
import { parseSkillMd } from "./skill-md-parser.js";

const ORIGINAL_CONFIG = getRuntimeConfig();
const ORIGINAL_DATA_DIR = process.env.LAX_DATA_DIR;
let workspace = "";

function workflowCandidate(): LearnedCandidate {
  const description = "Workflow \"coding:read_file -> write_file -> run_tests\" completed cleanly 3/4 times";
  const examples = ["read_file -> write_file -> run_tests"];
  return {
    ...WORKFLOW_TACTIC_IDENTITY,
    id: deriveCandidateId("workflow", description, examples),
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
      ...TERMINAL_TELEMETRY_IDENTITY,
      patternType: "workflow",
      description,
      occurrences: 4,
      lastSeen: 1_750_000_000_000,
      examples,
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

function markActive(candidate: LearnedCandidate): void {
  candidate.state = "active";
  candidate.transitions = [
    { from: "candidate", to: "approved", timestamp: candidate.createdAt },
    { from: "approved", to: "active", timestamp: candidate.updatedAt },
  ];
}

function rekey(candidate: LearnedCandidate, sequence: string): void {
  candidate.evidence.description = `Workflow \"coding:${sequence}\" completed cleanly 3/4 times`;
  candidate.evidence.examples = [sequence];
  candidate.suggestion.config.sequence = [sequence];
  candidate.id = deriveCandidateId("workflow", candidate.evidence.description, candidate.evidence.examples);
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "lax-learned-drafting-"));
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

describe("learned protocol drafting", () => {
  it("rejects partial and cross-class evidence identities", () => {
    const partial = workflowCandidate();
    delete partial.authority;
    expect(() => draftLearnedCandidate(partial)).toThrow(/mismatched evidence authority/);

    const crossClass = workflowCandidate();
    Object.assign(crossClass.evidence, WORKFLOW_TACTIC_IDENTITY);
    expect(() => draftLearnedCandidate(crossClass)).toThrow(/mismatched evidence authority/);
  });

  it("turns revoked or accessor-backed suggestion structure into controlled rejection", () => {
    const revoked = workflowCandidate();
    const suggestion = Proxy.revocable(revoked.suggestion, {});
    revoked.suggestion = suggestion.proxy;
    suggestion.revoke();
    expect(() => draftLearnedCandidate(revoked)).toThrow(Error);
    expect(() => draftLearnedCandidate(revoked)).not.toThrow(TypeError);

    let reads = 0;
    const accessor = workflowCandidate();
    Object.defineProperty(accessor.suggestion, "config", {
      configurable: true,
      enumerable: true,
      get() { reads++; throw new Error("config getter executed"); },
    });
    expect(() => draftLearnedCandidate(accessor)).toThrow(/mismatched evidence authority/);
    expect(reads).toBe(0);
  });

  it("rejects non-workflow, unproven, and malformed candidates", () => {
    const nonWorkflow = workflowCandidate();
    nonWorkflow.evidence.patternType = "task";
    expect(() => draftLearnedCandidate(nonWorkflow)).toThrow(/mismatched evidence authority/);

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

  it("rebuilds missing active candidates but requires matching managed history for refinements", () => {
    const unmanaged = workflowCandidate();
    markActive(unmanaged);
    const rebuilt = draftLearnedCandidate(unmanaged);
    expect(rebuilt.created).toBe(true);
    expect(loadLearnedProtocol(rebuilt.slug).state).toBe("draft");

    const mismatched = workflowCandidate();
    rekey(mismatched, "read_file -> mismatch -> run_tests");
    markActive(mismatched);
    createLearnedProtocolDraft({
      slug: mismatched.id,
      skillMd: renderLearnedCandidateSkill({ ...mismatched, state: "candidate", transitions: [] }),
      metadata: { candidateId: "learned-ffffffffffffffffffff" },
    });
    expect(() => draftLearnedCandidate(mismatched)).toThrow(/does not match its managed candidate history/);

    const original = workflowCandidate();
    rekey(original, "read_file -> distinct -> run_tests");
    const first = draftLearnedCandidate(original);
    activateLearnedProtocol({ slug: first.slug, versionId: first.version.id, expectedActiveVersionId: null });
    const stronger = workflowCandidate();
    rekey(stronger, "read_file -> distinct -> run_tests");
    markActive(stronger);
    stronger.evidence.occurrences = 5;
    stronger.evidence.description = "Workflow \"coding:read_file -> distinct -> run_tests\" completed cleanly 4/5 times";
    stronger.evidence.outcomeStats = { clean: 4, partial: 1, aborted: 0, successRate: 0.8, weightedSuccessRate: 0.85, distinctSessions: 4 };
    stronger.suggestion.config.occurrences = 5;
    stronger.confidence = 0.85;

    expect(draftLearnedCandidate(stronger).created).toBe(true);
  });

  it("keeps drafted candidates undiscoverable until another layer activates them", () => {
    const drafted = draftLearnedCandidate(workflowCandidate());

    expect(loadImportedProtocols().map((protocol) => protocol.name)).not.toContain(drafted.slug);
    const immutableBody = readFileSync(join(learnedProtocolsDir(), drafted.slug, "versions", drafted.version.id, "SKILL.md"), "utf8");
    expect(immutableBody).toContain("# Learned workflow");
  });
});
