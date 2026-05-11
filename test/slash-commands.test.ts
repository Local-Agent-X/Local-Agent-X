/**
 * Slash-command interceptor tests.
 *
 * Verifies:
 *   - Known commands expand with the SKILL.md body inlined
 *   - Unknown commands pass through (return null)
 *   - Non-slash messages pass through (return null)
 *   - Case-insensitive command names
 *   - Arg text is captured and surfaced in the rewritten message
 *   - Bare /<command> (no args) tells the agent to ask the user
 *   - listAvailableSlashCommands returns the three bundled skills
 */

import { describe, it, expect } from "vitest";
import { expandSlashCommand, listAvailableSlashCommands } from "../src/slash-commands.js";

describe("expandSlashCommand — known commands", () => {
  it("expands /app-build with arg", () => {
    const r = expandSlashCommand("/app-build a calendar booking app for solo coaches");
    expect(r).not.toBeNull();
    expect(r!.command).toBe("app-build");
    expect(r!.argText).toBe("a calendar booking app for solo coaches");
    expect(r!.agentMessage).toContain("SLASH COMMAND");
    expect(r!.agentMessage).toContain("/app-build");
    // SKILL.md body inlined — sanity-check a known phrase from app-build
    expect(r!.agentMessage.toLowerCase()).toMatch(/spec|chunk|scenarios/);
    expect(r!.agentMessage).toContain("a calendar booking app for solo coaches");
  });

  it("expands /senior-engineer with task", () => {
    const r = expandSlashCommand("/senior-engineer fix the race in chat-ws.ts");
    expect(r).not.toBeNull();
    expect(r!.command).toBe("senior-engineer");
    expect(r!.argText).toBe("fix the race in chat-ws.ts");
    expect(r!.agentMessage).toContain("smallest correct change");
  });

  it("expands /vibe-code with task", () => {
    const r = expandSlashCommand("/vibe-code add a landing page");
    expect(r).not.toBeNull();
    expect(r!.command).toBe("vibe-code");
    expect(r!.agentMessage.toLowerCase()).toContain("vibe code in prod responsibly");
  });

  it("handles bare /app-build (no args) by instructing the agent to ask", () => {
    const r = expandSlashCommand("/app-build");
    expect(r).not.toBeNull();
    expect(r!.argText).toBe("");
    expect(r!.agentMessage).toContain("no argument");
    expect(r!.agentMessage.toLowerCase()).toContain("ask");
  });

  it("normalizes uppercase command names to lowercase lookup", () => {
    const r = expandSlashCommand("/APP-BUILD a tiny inventory tracker");
    expect(r).not.toBeNull();
    expect(r!.command).toBe("app-build");
  });

  it("preserves the original message for UI display", () => {
    const original = "/app-build a coffee shop POS";
    const r = expandSlashCommand(original);
    expect(r!.originalMessage).toBe(original);
  });

  it("captures multi-line arg text", () => {
    const r = expandSlashCommand("/app-build a thing\nwith multiple\nrequirement lines");
    expect(r).not.toBeNull();
    expect(r!.argText).toContain("multiple");
    expect(r!.argText).toContain("requirement lines");
  });

  it("trims whitespace around the arg", () => {
    const r = expandSlashCommand("/app-build    spaced out   ");
    expect(r!.argText).toBe("spaced out");
  });
});

describe("expandSlashCommand — pass-through cases", () => {
  it("returns null for plain text without a slash prefix", () => {
    expect(expandSlashCommand("hello there")).toBeNull();
    expect(expandSlashCommand("can you /app-build something")).toBeNull();
  });

  it("returns null for unknown slash commands", () => {
    expect(expandSlashCommand("/nonsense-command stuff")).toBeNull();
    expect(expandSlashCommand("/help")).toBeNull(); // not bundled yet
  });

  it("returns null for empty or whitespace-only input", () => {
    expect(expandSlashCommand("")).toBeNull();
    expect(expandSlashCommand("   ")).toBeNull();
  });

  it("returns null for a bare slash", () => {
    expect(expandSlashCommand("/")).toBeNull();
    expect(expandSlashCommand("/ ")).toBeNull();
  });

  it("returns null when slash is mid-message (e.g., a URL path)", () => {
    expect(expandSlashCommand("look at https://example.com/app-build for context")).toBeNull();
  });
});

describe("listAvailableSlashCommands", () => {
  it("returns the three canonical skill bundles shipped in the repo", () => {
    const cmds = listAvailableSlashCommands();
    expect(cmds).toContain("app-build");
    expect(cmds).toContain("senior-engineer");
    expect(cmds).toContain("vibe-code");
  });
});
