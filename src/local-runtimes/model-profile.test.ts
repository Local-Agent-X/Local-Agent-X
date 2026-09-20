// The declared model profile: bundled files load and hash, a user file adds or
// overrides one field at a time, the kernel policy can only be tightened, a
// broken user file is ignored rather than fatal, and the tier classifier
// takes the declared tier over its name heuristic.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";

const data = mkdtempSync(join(tmpdir(), "lax-model-profile-"));
process.env.LAX_DATA_DIR = data;

const { resolveModelProfile, modelProfileTier, profileFileName, hashProfile, _resetModelProfilesForTests, USER_PROFILE_SUBDIR } = await import("./model-profile.js");
const { classifyModel } = await import("../model-tiers.js");

function writeUserProfile(modelId: string, body: unknown) {
  const dir = join(data, USER_PROFILE_SUBDIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, profileFileName(modelId)), JSON.stringify(body));
}

beforeEach(() => _resetModelProfilesForTests());

describe("bundled profiles", () => {
  it("load for both test models with a stable content hash", () => {
    const big = resolveModelProfile("qwen3.6:27b")!;
    const small = resolveModelProfile("qwen3:8b")!;
    expect(big.tier).toBe("B");
    expect(small.tier).toBe("C");
    expect(big.profileId).toBe("qwen3.6:27b");
    expect(big.profileHash).toMatch(/^[0-9a-f]{12}$/);
    expect(big.source).toBe("bundled");
    expect(big.profileHash).not.toBe(small.profileHash);
    const { profileId: _i, profileHash: _h, source: _s, ...plain } = big;
    expect(hashProfile(plain)).toBe(big.profileHash);
  });

  it("describe today's behaviour, so adopting them changes nothing", () => {
    expect(resolveModelProfile("qwen3.6:27b")!.maxToolsExposed).toBe(30);
    expect(resolveModelProfile("qwen3:8b")!.maxToolsExposed).toBe(8);
    expect(resolveModelProfile("qwen3.6:27b")!.sampling.toolStep.temperature).toBe(0.7);
    expect(resolveModelProfile("qwen3:8b")!.thinking.mode).toBe("all");
  });

  it("is null for a model with no profile", () => {
    expect(resolveModelProfile("nobody:99b")).toBeNull();
    expect(modelProfileTier("nobody:99b")).toBeNull();
  });
});

describe("user overrides", () => {
  it("override one field over the bundled profile and change the hash", () => {
    const before = resolveModelProfile("qwen3:8b")!;
    _resetModelProfilesForTests();
    writeUserProfile("qwen3:8b", { maxToolsExposed: 5, thinking: { mode: "off" } });
    const after = resolveModelProfile("qwen3:8b")!;
    expect(after.maxToolsExposed).toBe(5);
    expect(after.thinking.mode).toBe("off");
    expect(after.thinking.budgetMechanism).toBe("max_tokens");
    expect(after.source).toBe("bundled+user");
    expect(after.profileHash).not.toBe(before.profileHash);
  });

  it("a user file alone must be a whole profile, and then it counts", () => {
    const bundled = resolveModelProfile("qwen3:8b")!;
    const { profileId: _i, profileHash: _h, source: _s, ...whole } = bundled;
    writeUserProfile("mine:1b", { ...whole, id: "mine:1b", tier: "A" });
    const mine = resolveModelProfile("mine:1b")!;
    expect(mine.source).toBe("user");
    expect(mine.tier).toBe("A");
  });

  it("cannot loosen the kernel policy below the tier floor, and a broken file is ignored", () => {
    writeUserProfile("qwen3:8b", { kernelPolicy: "anything-goes" });
    expect(resolveModelProfile("qwen3:8b")!.kernelPolicy).toBe("workspace-assistant");
    _resetModelProfilesForTests();
    writeUserProfile("qwen3:8b", { maxToolsExposed: "eight" });
    expect(resolveModelProfile("qwen3:8b")!.maxToolsExposed).toBe(8);
    _resetModelProfilesForTests();
    writeUserProfile("qwen3:8b", { id: "someone-else:8b" });
    expect(resolveModelProfile("qwen3:8b")!.profileId).toBe("qwen3:8b");
  });
});

describe("classifyModel with a declared profile", () => {
  it("takes the declared tier over the name heuristic", () => {
    // The name says 1B, which the heuristic calls weak; the profile says A.
    const { profileId: _i, profileHash: _h, source: _s, ...whole } = resolveModelProfile("qwen3:8b")!;
    _resetModelProfilesForTests();
    writeUserProfile("declared:1b", { ...whole, id: "declared:1b", tier: "A" });
    expect(classifyModel("declared:1b")).toBe("strong");
    expect(classifyModel("undeclared:1b")).toBe("weak");
  });

  it("keeps today's tiers for the two test models", () => {
    expect(classifyModel("qwen3.6:27b")).toBe("medium");
    expect(classifyModel("qwen3:8b")).toBe("weak");
  });
});
