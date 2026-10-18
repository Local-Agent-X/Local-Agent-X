import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  taskNeedsArtifactEdit,
  canEditArtifacts,
  spawnMismatchMessage,
} from "./spawn-guard.js";

// The shell term of edit capability is judged by the unattended-shell gate's
// own predicate, which reads getSandboxStatus(); pin it so the matrix below
// is deterministic on any host.
const sandbox = vi.hoisted(() => ({ status: {} as Record<string, unknown> }));
vi.mock("../sandbox/index.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getSandboxStatus: () => sandbox.status };
});
/** Guarded selection that fell back to the unconfined host, no acknowledgement:
 *  an unattended shell call is parked for a person. */
function setUnconfinedHost() {
  sandbox.status = {
    selectedMode: "guarded", effectiveMode: "host", confined: false,
    unconfinedHostAcknowledged: false, proofPending: false,
    delegatedShellAllowed: false, apiShellAllowed: false,
  };
}
/** Effective confined sandbox: an unattended shell call runs. */
function setConfined() {
  sandbox.status = {
    selectedMode: "guarded", effectiveMode: "guarded", confined: true,
    unconfinedHostAcknowledged: false, proofPending: false,
    delegatedShellAllowed: true, apiShellAllowed: true,
  };
}
beforeEach(setUnconfinedHost);

const RESEARCHER_TOOLS = ["web_fetch", "http_request", "read", "write"];
const CODER_TOOLS = ["read", "write", "edit", "bash", "build_app"];
const SHELL_ONLY_TOOLS = ["read", "write", "bash"];

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
  it("researcher toolset cannot edit artifacts (write alone doesn't qualify), in any run", () => {
    setConfined();
    expect(canEditArtifacts(RESEARCHER_TOOLS, "local")).toBe(false);
    expect(canEditArtifacts(RESEARCHER_TOOLS, "delegated")).toBe(false);
  });

  it("coder toolset can, even in an unattended run without a sandbox (edit does not need the shell)", () => {
    expect(canEditArtifacts(CODER_TOOLS, "delegated")).toBe(true);
    expect(canEditArtifacts(CODER_TOOLS, "cron")).toBe(true);
  });

  it("every in-place editor, search root and office family qualifies, read off the rows, with no shell available", () => {
    for (const tool of ["edit", "edit_lines", "multi_edit", "bulk_replace", "grep", "glob", "structural_search", "document", "spreadsheet", "presentation", "build_app"]) {
      expect(canEditArtifacts(["read", "write", tool], "delegated"), tool).toBe(true);
    }
    for (const tool of ["write", "pdf", "create_chart", "web_fetch", "memory_save", "send_file"]) {
      expect(canEditArtifacts(["read", "write", tool], "delegated"), tool).toBe(false);
    }
  });

  describe("a role whose only edit path is the shell", () => {
    it("qualifies for an attended run whatever the sandbox (the user is there to answer)", () => {
      expect(canEditArtifacts(SHELL_ONLY_TOOLS, "local")).toBe(true);
      setConfined();
      expect(canEditArtifacts(SHELL_ONLY_TOOLS, "local")).toBe(true);
    });

    it("does not qualify for an unattended run on an unconfined, unacknowledged host: its shell call would be parked, not run", () => {
      expect(canEditArtifacts(SHELL_ONLY_TOOLS, "delegated")).toBe(false);
      expect(canEditArtifacts(SHELL_ONLY_TOOLS, "cron")).toBe(false);
      expect(canEditArtifacts(SHELL_ONLY_TOOLS, "api")).toBe(false);
    });

    it("qualifies for an unattended run inside a confined sandbox", () => {
      setConfined();
      expect(canEditArtifacts(SHELL_ONLY_TOOLS, "delegated")).toBe(true);
      expect(canEditArtifacts(SHELL_ONLY_TOOLS, "cron")).toBe(true);
    });

    it("qualifies for an unattended run on a host the user acknowledged", () => {
      sandbox.status = { ...sandbox.status, unconfinedHostAcknowledged: true, delegatedShellAllowed: true, apiShellAllowed: true };
      expect(canEditArtifacts(SHELL_ONLY_TOOLS, "delegated")).toBe(true);
    });

    it("every shell-command row is the shell term, read off the rows", () => {
      for (const tool of ["bash", "process_start", "process_restart"]) {
        expect(canEditArtifacts(["read", tool], "delegated"), tool).toBe(false);
        expect(canEditArtifacts(["read", tool], "local"), tool).toBe(true);
      }
    });

    it("the rejection for that run names the capable agents", () => {
      const roster = [
        { name: "Coder", role: "coder", allowedTools: CODER_TOOLS, id: "tpl-coder" },
        { name: "Shell", role: "shell-worker", allowedTools: SHELL_ONLY_TOOLS, id: "tpl-shell" },
      ];
      const capable = roster.filter((d) => canEditArtifacts(d.allowedTools, "delegated"));
      const msg = spawnMismatchMessage("shell-worker", SHELL_ONLY_TOOLS, capable);
      expect(msg).toContain('Coder ("coder", id: tpl-coder)');
      expect(msg).not.toContain("tpl-shell");
    });
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
