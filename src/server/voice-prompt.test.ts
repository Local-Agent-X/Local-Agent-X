import { describe, it, expect } from "vitest";
import type { ToolDefinition } from "../types.js";
import { VOICE_FAST_TOOLS, buildVoiceTail, voiceToolManifest } from "./voice-prompt.js";

const tool = (name: string): ToolDefinition => ({
  name, description: `${name} does its job.`, parameters: { type: "object", properties: {} },
  execute: async () => ({ content: "", isError: false }),
} as unknown as ToolDefinition);

describe("voice tool belt", () => {
  it("can look up and save memory, so a spoken turn never says it doesn't have what was discussed", () => {
    // Without these a voice call told the user it had no job description that
    // an October chat covered in detail, and had no way to keep a new date.
    for (const t of ["memory_search", "search_past_sessions", "remember", "memory_set_user_field", "show_card"]) {
      expect(VOICE_FAST_TOOLS).toContain(t);
    }
  });

  it("tells the spoken model to check memory before saying it doesn't know", () => {
    const tail = buildVoiceTail(false);
    expect(tail).toContain("memory_search");
    expect(tail).toContain("search_past_sessions");
    expect(tail).toContain("remember");
    // A spoken "stop calling me X" fixes the name the profile gives every prompt.
    expect(tail).toContain("memory_set_user_field");
    // Things worth seeing are shown as cards, not read aloud.
    expect(tail).toContain("show_card");
  });

  it("tells the spoken model to search the user's mail for a person's address before asking for it", () => {
    // A spoken "email Tyler" checked only memory and said it had no address;
    // Tyler's messages in the inbox had it (2026-11-11).
    expect(buildVoiceTail(false)).toMatch(/email address[\s\S]*email_search[\s\S]*before asking the user/);
  });

  it("can search for any other tool, so a spoken turn is never stuck with the belt it started with", () => {
    // A voice call failed a lookup because the tool it needed was not on the belt
    // and it had no way to load one.
    expect(VOICE_FAST_TOOLS).toContain("tool_search");
    expect(buildVoiceTail(false)).toContain("tool_search");
  });

  it("names every tool the belt lacks, and none it carries, for tool_search to load", () => {
    const belt = [tool("web_search"), tool("tool_search")];
    const catalog = [...belt, tool("gmail_read"), tool("mission_schedule_delete")];
    const manifest = voiceToolManifest(catalog, belt, "voice-test");
    expect(manifest).toContain("More tools available on demand (2)");
    expect(manifest).toContain("gmail_read");
    expect(manifest).toContain("mission_schedule_delete");
    expect(manifest).not.toContain("- web_search");
    // Nothing to load: no section at all, so the prompt carries no empty heading.
    expect(voiceToolManifest(belt, belt, "voice-test")).toBe("");
  });
});
