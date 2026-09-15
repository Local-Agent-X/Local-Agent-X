// app-manifest is snapshotted per session so the watcher rewriting file counts
// mid-session can't change the cached system-prompt prefix; a new session (or a
// caller with no session) reads the current manifest. AGENTS.md is NOT: a rule
// edit must govern the very next message of the same session.
import { beforeEach, describe, expect, it, vi } from "vitest";

let manifest = "MANIFEST v1";
vi.mock("../manifest-generator/index.js", () => ({ getManifestSummary: () => manifest }));
let agentsMd = "## Invariants (AGENTS.md)\nrule v1";
vi.mock("./agents-md-section.js", () => ({ readAgentsMdSection: async () => agentsMd }));

import { createSystemPromptBuilder } from "./system-prompt-builder.js";
import { _resetSessionSnapshotsForTests } from "./session-prompt-snapshot.js";

async function renderSection(id: string, sessionId?: string): Promise<string | undefined> {
  const built = await createSystemPromptBuilder({ basePrompt: "## Base\nx", providerHint: "", sessionId }).buildWithTelemetry();
  return built.renderedSections.find((s) => s.id === id)?.text;
}

const renderManifest = (sessionId?: string) => renderSection("app-manifest", sessionId);

beforeEach(() => {
  _resetSessionSnapshotsForTests();
  manifest = "MANIFEST v1";
  agentsMd = "## Invariants (AGENTS.md)\nrule v1";
});

describe("per-session prompt snapshots", () => {
  it("keeps the first manifest for the rest of the session", async () => {
    expect(await renderManifest("s1")).toBe("MANIFEST v1");
    manifest = "MANIFEST v2";
    expect(await renderManifest("s1")).toBe("MANIFEST v1");
  });

  it("a new session reads the current manifest", async () => {
    await renderManifest("s1");
    manifest = "MANIFEST v2";
    expect(await renderManifest("s2")).toBe("MANIFEST v2");
  });

  it("without a session id every build re-reads", async () => {
    expect(await renderManifest()).toBe("MANIFEST v1");
    manifest = "MANIFEST v2";
    expect(await renderManifest()).toBe("MANIFEST v2");
  });

  it("an AGENTS.md edit reaches the next message of the same session", async () => {
    expect(await renderSection("agents-md", "s1")).toContain("rule v1");
    agentsMd = "## Invariants (AGENTS.md)\nrule v2";
    expect(await renderSection("agents-md", "s1")).toContain("rule v2");
  });
});
