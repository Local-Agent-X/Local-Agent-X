import { describe, it, expect } from "vitest";
import {
  taskNeedsArtifactEdit,
  canEditArtifacts,
  spawnMismatchMessage,
} from "./spawn-guard.js";

const RESEARCHER_TOOLS = ["web_fetch", "http_request", "read", "write"];
const CODER_TOOLS = ["read", "write", "edit", "bash", "build_app"];

describe("taskNeedsArtifactEdit", () => {
  it("matches both observed failure tasks (2026-06-09 Charizard runs)", () => {
    expect(taskNeedsArtifactEdit(
      "look up original Charizard pokemon card US version from the 90's and see what a psa 10 would be worth then add it to my pokemon card collection dashboard",
    )).toBe(true);
    expect(taskNeedsArtifactEdit(
      "Look up the original US Charizard Pokémon card from the 1990s (Base Set), find current market value for a PSA 10. Then add the card details and price info to the user's Pokémon card collection dashboard app in workspace/apps/",
    )).toBe(true);
  });

  it("matches common edit-existing phrasings", () => {
    expect(taskNeedsArtifactEdit("fix the bug in my app")).toBe(true);
    expect(taskNeedsArtifactEdit("update the existing dashboard with new prices")).toBe(true);
    expect(taskNeedsArtifactEdit("remove the duplicates from our tracker")).toBe(true);
  });

  it("does not match research or new-artifact tasks", () => {
    expect(taskNeedsArtifactEdit("look up the PSA 10 value of a Base Set Charizard and summarize")).toBe(false);
    expect(taskNeedsArtifactEdit("write a 500 word report on supplement trends")).toBe(false);
    expect(taskNeedsArtifactEdit("create a summary file of your findings")).toBe(false);
  });
});

describe("canEditArtifacts", () => {
  it("researcher toolset cannot edit artifacts (write alone doesn't qualify)", () => {
    expect(canEditArtifacts(RESEARCHER_TOOLS)).toBe(false);
  });

  it("coder toolset can", () => {
    expect(canEditArtifacts(CODER_TOOLS)).toBe(true);
  });

  it("bash alone qualifies (discovery + mutation)", () => {
    expect(canEditArtifacts(["bash"])).toBe(true);
  });
});

describe("spawnMismatchMessage", () => {
  it("names capable agents and keeps delegation framed as correct", () => {
    const msg = spawnMismatchMessage("researcher", RESEARCHER_TOOLS, [
      { name: "Coder", role: "coder", id: "tpl-coder" },
    ]);
    expect(msg).toContain('Coder ("coder", id: tpl-coder)');
    expect(msg).toContain("Delegation is the right instinct");
    expect(msg).toContain("split the task");
  });

  it("points at agent_create when no capable agent exists on the roster", () => {
    const msg = spawnMismatchMessage("researcher", RESEARCHER_TOOLS, []);
    expect(msg).toContain("agent_create");
  });
});
