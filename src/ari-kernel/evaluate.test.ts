import { describe, it, expect } from "vitest";
import { isKernelSensitiveFileFalsePositive } from "./evaluate.js";

// The ARI runtime flags a file path as "sensitive" by unanchored substring
// (/password|credential|token|secret|.env|id_rsa/) and QUARANTINES the run on a
// match. A normally-named source file (passwordReset.ts) trips it, bricking a
// legitimate coding op read-only. isKernelSensitiveFileFalsePositive is the gate
// that overrides ONLY a true false positive: the sensitive-file TRIGGER reason on
// a path LAX's canonical (anchored) detector says is NOT a real secret.

const TRIGGER = "Action 'file.write' denied: behavioral rule triggered by sensitive file access. Run has been quarantined.";
const CASCADE = "Run entered restricted mode at 2026-07-01T19:35:02.645Z after 1 denied sensitive actions. Only read-only safe actions are allowed. 'file.write' is blocked.";

describe("isKernelSensitiveFileFalsePositive — override only true false positives", () => {
  it("overrides a benign source file the kernel flagged by substring", () => {
    for (const p of [
      "/Users/dad/lais-eval/local-ai-studio-main/server/passwordReset.ts",
      "/Users/dad/proj/src/userPreferences.ts",
      "/Users/dad/proj/src/tokenStore.ts",
      "/Users/dad/proj/src/authGuard.ts",
    ]) {
      expect(isKernelSensitiveFileFalsePositive(TRIGGER, { path: p })).toBe(true);
    }
  });

  it("does NOT override a genuine secret file — the kernel's denial stands", () => {
    for (const p of [
      "/Users/dad/.ssh/id_rsa",
      "/Users/dad/proj/.env",
      "/Users/dad/.aws/credentials",
    ]) {
      expect(isKernelSensitiveFileFalsePositive(TRIGGER, { path: p })).toBe(false);
    }
  });

  it("does NOT override on the restricted-mode CASCADE — a benign write must not clear a genuine quarantine", () => {
    // Even for a benign path, the cascade reason means a PRIOR action already
    // quarantined (possibly a real secret read). Overriding here would let any
    // benign write reset that legitimate quarantine.
    expect(isKernelSensitiveFileFalsePositive(CASCADE, { path: "/Users/dad/proj/src/userPreferences.ts" })).toBe(false);
  });

  it("does NOT override an unrelated denial reason (capability/policy), even on a benign path", () => {
    expect(isKernelSensitiveFileFalsePositive("Denied: capability 'file.write' not granted", { path: "/Users/dad/proj/src/passwordReset.ts" })).toBe(false);
  });

  it("does NOT override when no file path is present in params", () => {
    expect(isKernelSensitiveFileFalsePositive(TRIGGER, {})).toBe(false);
    expect(isKernelSensitiveFileFalsePositive(TRIGGER, { command: "ls" })).toBe(false);
  });

  it("reads the path from file_path / filePath too", () => {
    expect(isKernelSensitiveFileFalsePositive(TRIGGER, { file_path: "/Users/dad/proj/src/passwordReset.ts" })).toBe(true);
    expect(isKernelSensitiveFileFalsePositive(TRIGGER, { filePath: "/Users/dad/.ssh/id_rsa" })).toBe(false);
  });
});
