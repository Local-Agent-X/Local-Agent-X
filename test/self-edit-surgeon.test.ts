/**
 * Tests for self_edit surgeon selection (surgeon.ts) and the provider-aware
 * env scrub (child-env.ts).
 *
 * resolveSurgeon picks the best available coding agent: the active provider's
 * own CLI → any other installed+authed CLI → the generic in-loop surgeon.
 * cliSpecForProvider is the pure provider→CLI mapping. buildSelfEditChildEnv
 * passes through ONLY that provider's own auth and strips the rest.
 */

import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { cliSpecForProvider, resolveSurgeon, formatSurgeonOutput, type CliSurgeonSpec } from "../src/self-edit/surgeon.js";
import { buildSelfEditChildEnv } from "../src/self-edit/child-env.js";

describe("cliSpecForProvider (pure mapping)", () => {
  it("maps anthropic → claude", () => expect(cliSpecForProvider("anthropic")?.bin).toBe("claude"));
  it("maps codex AND openai → codex", () => {
    expect(cliSpecForProvider("codex")?.bin).toBe("codex");
    expect(cliSpecForProvider("openai")?.bin).toBe("codex");
  });
  it("maps xai → grok", () => expect(cliSpecForProvider("xai")?.bin).toBe("grok"));
  it("is case-insensitive", () => expect(cliSpecForProvider("XAI")?.bin).toBe("grok"));
  it("returns null for providers with no coding CLI", () => {
    for (const p of ["gemini", "cerebras", "ollama", "local", "custom"]) {
      expect(cliSpecForProvider(p), `${p} has no CLI`).toBeNull();
    }
  });
  it("grok takes the prompt via file; claude/codex via stdin", () => {
    expect(cliSpecForProvider("xai")?.promptVia).toBe("file");
    expect(cliSpecForProvider("anthropic")?.promptVia).toBe("stdin");
    expect(cliSpecForProvider("codex")?.promptVia).toBe("stdin");
  });
});

describe("resolveSurgeon (availability-aware)", () => {
  const all = () => true;
  const none = () => false;
  const only = (p: string) => (s: CliSurgeonSpec) => s.provider === p;

  it("uses the active provider's own CLI when available", () => {
    const s = resolveSurgeon({ provider: "xai", isAvailable: all });
    expect(s.kind).toBe("cli");
    expect((s as CliSurgeonSpec).bin).toBe("grok");
  });

  it("prefers the active provider's CLI over others even when all are available", () => {
    const s = resolveSurgeon({ provider: "codex", isAvailable: all });
    expect((s as CliSurgeonSpec).bin).toBe("codex");
  });

  it("falls back to another installed CLI off-provider", () => {
    const s = resolveSurgeon({ provider: "xai", isAvailable: only("anthropic") });
    expect((s as CliSurgeonSpec).bin).toBe("claude");
  });

  it("an unmapped provider uses any available CLI", () => {
    const s = resolveSurgeon({ provider: "gemini", isAvailable: only("codex") });
    expect((s as CliSurgeonSpec).bin).toBe("codex");
  });

  it("falls back to the generic loop when no CLI is available", () => {
    expect(resolveSurgeon({ provider: "xai", isAvailable: none }).kind).toBe("generic");
    expect(resolveSurgeon({ provider: "gemini", isAvailable: none }).kind).toBe("generic");
  });
});

describe("buildSelfEditChildEnv — provider-aware auth", () => {
  const BASE: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin", HOME: "/home/user",
    ANTHROPIC_API_KEY: "sk-ant-x", OPENAI_API_KEY: "sk-openai-x", XAI_API_KEY: "xai-x",
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
    expect(buildSelfEditChildEnv(BASE, "xai").PATH).toContain(join(homedir(), ".grok", "bin"));
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
