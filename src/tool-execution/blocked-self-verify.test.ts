// Unit test for blockedSelfVerifyGuidance (enforce-policy.ts): a delegated agent
// blocked from running the project's build/type-check on source must be told the
// harness verifies automatically — NOT the generic "find a safer way (often a
// dedicated tool exists)" hint that sent grok hunting a nonexistent executor.

import { describe, it, expect } from "vitest";
import { blockedSelfVerifyGuidance } from "./shell-block-guidance.js";

describe("blockedSelfVerifyGuidance", () => {
  const verifyCommands = [
    "npx tsc --noEmit",
    "node_modules/.bin/tsc --noEmit",
    "cd /Users/x/proj && npx tsc",
    "npm run build",
    "npm run check",
    "npm run typecheck",
    "npm test",
    "pnpm lint",
    "yarn build",
    "vitest run",
    "eslint .",
  ];

  for (const command of verifyCommands) {
    it(`gives harness-verify guidance for a blocked shell verify: ${command}`, () => {
      const g = blockedSelfVerifyGuidance("bash", { command });
      expect(g).not.toBeNull();
      expect(g!.recovery).toMatch(/harness runs the project's build automatically/i);
      expect(g!.recovery).toMatch(/stop retrying/i);
      expect(g!.userHint).toMatch(/harness verifies/i);
    });
  }

  it("does not fire for a non-verify shell command", () => {
    expect(blockedSelfVerifyGuidance("bash", { command: "git status" })).toBeNull();
    expect(blockedSelfVerifyGuidance("bash", { command: "ls -la" })).toBeNull();
    expect(blockedSelfVerifyGuidance("bash", { command: "cat package.json" })).toBeNull();
  });

  it("does not fire for a non-shell tool, even with a verify-shaped command", () => {
    // The guidance is about shell execution being blocked; file tools aren't shell.
    expect(blockedSelfVerifyGuidance("read", { command: "npx tsc" })).toBeNull();
    expect(blockedSelfVerifyGuidance("edit", { command: "npm run build" })).toBeNull();
  });

  it("is null-safe on missing / malformed args", () => {
    expect(blockedSelfVerifyGuidance("bash", {})).toBeNull();
    expect(blockedSelfVerifyGuidance("bash", undefined)).toBeNull();
    expect(blockedSelfVerifyGuidance("bash", { command: 42 })).toBeNull();
  });

  // Chunk K: when shell IS available to the delegated agent (worktree +
  // effective OS containment → SecurityLayer.delegatedShellContained), the
  // "you can't run shell, the harness verifies" redirect would MISINFORM — the
  // agent can run its own verify. Suppress it. When shell is genuinely
  // unavailable (default false), the redirect still fires.
  it("SUPPRESSES the redirect when the delegated agent's shell is available (contained)", () => {
    for (const command of verifyCommands) {
      expect(blockedSelfVerifyGuidance("bash", { command }, true)).toBeNull();
    }
  });

  it("STILL fires the redirect when shell is unavailable (no worktree / unconfined / cron)", () => {
    // shellAvailable=false is the default and the still-blocked case.
    expect(blockedSelfVerifyGuidance("bash", { command: "npm test" }, false)).not.toBeNull();
    expect(blockedSelfVerifyGuidance("bash", { command: "vitest run" }, false)).not.toBeNull();
    // omitted arg defaults to false → fires
    expect(blockedSelfVerifyGuidance("bash", { command: "npm test" })).not.toBeNull();
  });
});
