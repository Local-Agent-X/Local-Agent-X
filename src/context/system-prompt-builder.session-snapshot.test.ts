// app-manifest is snapshotted per session so the watcher rewriting file counts
// mid-session can't change the cached system-prompt prefix; a new session (or a
// caller with no session) reads the current manifest.
import { beforeEach, describe, expect, it, vi } from "vitest";

let manifest = "MANIFEST v1";
vi.mock("../manifest-generator/index.js", () => ({ getManifestSummary: () => manifest }));

import { _resetSessionSnapshotsForTests, createSystemPromptBuilder } from "./system-prompt-builder.js";

async function renderManifest(sessionId?: string): Promise<string | undefined> {
  const built = await createSystemPromptBuilder({ basePrompt: "## Base\nx", providerHint: "", sessionId }).buildWithTelemetry();
  return built.renderedSections.find((s) => s.id === "app-manifest")?.text;
}

beforeEach(() => {
  _resetSessionSnapshotsForTests();
  manifest = "MANIFEST v1";
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
});
