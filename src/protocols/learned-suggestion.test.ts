import { describe, expect, it } from "vitest";
import type { LearnedCandidate } from "../cognition/cross-session-learning/types.js";
import type { LearnedProtocolRecord } from "./learned-lifecycle.js";
import { selectLearnedProtocolSuggestion } from "./learned-suggestion.js";
import type { Protocol } from "./types.js";

function candidate(id: string, state: LearnedCandidate["state"] = "active"): LearnedCandidate {
  return {
    id, state, confidence: 0.9,
    suggestion: { type: "shortcut", name: id, description: id, config: {} },
    evidence: { patternType: "workflow", description: id, occurrences: 4, lastSeen: 1, examples: [] },
    createdAt: 1, updatedAt: 1, transitions: [],
  };
}

function protocol(name: string, description: string, triggers: string[]): Protocol {
  return {
    name, description, triggers, steps: [], rules: [], learnablePreferences: [],
    body: `# Secret body for ${name}\nRun internal tools in a fixed sequence.`,
    source: { type: "imported", sourcePath: `/tmp/${name}/SKILL.md` },
  };
}

function record(slug: string, state: LearnedProtocolRecord["state"] = "active"): LearnedProtocolRecord {
  const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  return {
    schemaVersion: 1, slug, state,
    activeVersionId: state === "draft" ? null : id,
    versions: [{ id, sha256: "hash", createdAt: "2026-07-18", metadata: { candidateId: slug } }],
  };
}

describe("learned protocol suggestion", () => {
  it("selects a relevant verified active learned protocol", () => {
    const item = candidate("learned-release-check");
    const loaded = protocol(item.id, "Validate release artifacts and checksum files", ["validate release checksums"]);
    const result = selectLearnedProtocolSuggestion(
      "Please validate the release checksums for these artifacts", [item], [loaded], () => record(item.id),
    );
    expect(result?.name).toBe(item.id);
  });

  it("does not suggest an irrelevant protocol or a generic single-token overlap", () => {
    const item = candidate("learned-release-check");
    const loaded = protocol(item.id, "Coding workflow for release checksums", ["release checksum workflow"]);
    const load = () => record(item.id);
    expect(selectLearnedProtocolSuggestion("Draft a customer email", [item], [loaded], load)).toBeNull();
    expect(selectLearnedProtocolSuggestion("Use the checksum workflow", [item], [loaded], load)).toBeNull();
  });

  it("returns only the deterministic highest-scoring match", () => {
    const broad = candidate("learned-release");
    const exact = candidate("learned-release-security");
    const result = selectLearnedProtocolSuggestion(
      "Validate release artifact signatures and checksums before deployment",
      [broad, exact],
      [
        protocol(broad.id, "Validate release artifacts", ["release artifacts"]),
        protocol(exact.id, "Validate release artifact signatures and checksums", ["release signatures checksums"]),
      ],
      (slug) => record(slug),
    );
    expect(result?.name).toBe(exact.id);
  });

  it.each(["draft", "archived"] as const)("skips %s lifecycle records", (state) => {
    const item = candidate("learned-release-check");
    const loaded = protocol(item.id, "Validate release artifacts and checksums", ["release artifact checksums"]);
    expect(selectLearnedProtocolSuggestion(
      "Validate release artifact checksums", [item], [loaded], () => record(item.id, state),
    )).toBeNull();
  });

  it("skips rejected candidates, orphaned records, and tampered records", () => {
    const id = "learned-release-check";
    const loaded = protocol(id, "Validate release artifacts and checksums", ["release artifact checksums"]);
    const message = "Validate release artifact checksums";
    expect(selectLearnedProtocolSuggestion(message, [candidate(id, "rejected")], [loaded], () => record(id))).toBeNull();
    expect(selectLearnedProtocolSuggestion(message, [], [loaded], () => record(id))).toBeNull();
    expect(selectLearnedProtocolSuggestion(message, [candidate(id)], [loaded], () => { throw new Error("hash mismatch"); })).toBeNull();
  });

  it("skips records that are not candidate-linked or canonically loaded imports", () => {
    const item = candidate("learned-release-check");
    const loaded = protocol(item.id, "Validate release artifacts and checksums", ["release artifact checksums"]);
    const unlinked = record(item.id);
    unlinked.versions[0].metadata.candidateId = "another-candidate";
    expect(selectLearnedProtocolSuggestion("Validate release artifact checksums", [item], [loaded], () => unlinked)).toBeNull();
    expect(selectLearnedProtocolSuggestion("Validate release artifact checksums", [item], [], () => record(item.id))).toBeNull();
  });

  it("emits only a short load nudge, never the protocol body or execution details", () => {
    const item = candidate("learned-release-check");
    const loaded = protocol(item.id, "Validate release artifacts and checksums", ["release artifact checksums"]);
    const result = selectLearnedProtocolSuggestion(
      "Validate release artifact checksums", [item], [loaded], () => record(item.id),
    );
    expect(result?.nudge).toContain(`protocol(action:"get", params:{name:"${item.id}"})`);
    expect(result?.nudge).not.toContain(loaded.body);
    expect(result?.nudge).not.toContain("internal tools");
    expect(result!.nudge.length).toBeLessThan(220);
  });
});
