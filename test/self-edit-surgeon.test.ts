/**
 * Tests for self_edit surgeon selection (surgeon.ts) and the provider-aware
 * env scrub (child-env.ts).
 *
 * resolveSurgeonSpec maps the active provider to a coding CLI:
 *   anthropic → claude, codex/openai → codex, xai → grok, everything else →
 *   claude (until the generic non-CLI surgeon ships). buildSelfEditChildEnv
 *   passes through ONLY that provider's own auth and strips the rest.
 */

import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveSurgeonSpec, formatSurgeonOutput } from "../src/self-edit/surgeon.js";
import { buildSelfEditChildEnv } from "../src/self-edit/child-env.js";

describe("resolveSurgeonSpec", () => {
  it("maps anthropic → claude", () => {
    expect(resolveSurgeonSpec("anthropic").bin).toBe("claude");
  });
  it("maps codex AND openai → codex", () => {
    expect(resolveSurgeonSpec("codex").bin).toBe("codex");
    expect(resolveSurgeonSpec("openai").bin).toBe("codex");
  });
  it("maps xai → grok", () => {
    expect(resolveSurgeonSpec("xai").bin).toBe("grok");
  });
  it("is case-insensitive", () => {
    expect(resolveSurgeonSpec("XAI").bin).toBe("grok");
    expect(resolveSurgeonSpec("Codex").bin).toBe("codex");
  });
  it("falls back to claude for every other provider (until the generic surgeon ships)", () => {
    for (const p of ["gemini", "cerebras", "ollama", "local", "custom", "anything"]) {
      expect(resolveSurgeonSpec(p).bin, `${p} should fall back to claude`).toBe("claude");
    }
  });
  it("grok takes the prompt via a file, not stdin", () => {
    expect(resolveSurgeonSpec("xai").promptVia).toBe("file");
    expect(resolveSurgeonSpec("anthropic").promptVia).toBe("stdin");
    expect(resolveSurgeonSpec("codex").promptVia).toBe("stdin");
  });
});

describe("buildSelfEditChildEnv — provider-aware auth", () => {
  const BASE: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/user",
    ANTHROPIC_API_KEY: "sk-ant-x",
    OPENAI_API_KEY: "sk-openai-x",
    XAI_API_KEY: "xai-x",
  };

  it("xai passes XAI_API_KEY and strips the other providers' keys", () => {
    const env = buildSelfEditChildEnv(BASE, "xai");
    expect(env.XAI_API_KEY).toBe("xai-x");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("codex passes OPENAI_API_KEY and strips the other providers' keys", () => {
    const env = buildSelfEditChildEnv(BASE, "codex");
    expect(env.OPENAI_API_KEY).toBe("sk-openai-x");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.XAI_API_KEY).toBeUndefined();
  });

  it("default (anthropic) passes ANTHROPIC_API_KEY and strips the rest", () => {
    const env = buildSelfEditChildEnv(BASE);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-x");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.XAI_API_KEY).toBeUndefined();
  });

  it("xai puts ~/.grok/bin on PATH so the grok binary resolves", () => {
    const env = buildSelfEditChildEnv(BASE, "xai");
    expect(env.PATH).toContain(join(homedir(), ".grok", "bin"));
  });
});

describe("formatSurgeonOutput", () => {
  it("reports a spawn error", () => {
    expect(formatSurgeonOutput({ exitCode: null, stdout: "", stderr: "", spawnError: "ENOENT", label: "Grok Build CLI", bin: "grok" }))
      .toBe("(grok spawn error: ENOENT)");
  });
  it("reports a non-zero exit with no output", () => {
    expect(formatSurgeonOutput({ exitCode: 1, stdout: "", stderr: "boom", label: "Codex CLI", bin: "codex" }))
      .toContain("(codex exited 1, no output)");
  });
  it("returns the stdout on success", () => {
    expect(formatSurgeonOutput({ exitCode: 0, stdout: "patched 3 files", stderr: "", label: "Claude Code", bin: "claude" }))
      .toBe("patched 3 files");
  });
});
