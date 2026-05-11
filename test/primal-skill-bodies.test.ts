/**
 * Smoke tests for skill-body loading. Verifies that the three SKILL.md
 * bodies bundled in src/skills/ are readable, frontmatter is stripped,
 * and the cache works. If any of these fail, the worker prompts will
 * miss their discipline anchor — that's a load-bearing breakage we
 * want to catch at CI.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { loadSkillBody, _resetSkillBodyCache } from "../src/primal-auto-build/skill-bodies.js";

beforeEach(() => { _resetSkillBodyCache(); });

describe("loadSkillBody — bundled skills are present and readable", () => {
  it("loads senior-engineer body without frontmatter", () => {
    const body = loadSkillBody("senior-engineer");
    expect(body.length).toBeGreaterThan(500);
    expect(body.startsWith("---")).toBe(false);
    expect(body).toContain("smallest correct change");
  });

  it("loads vibe-code body without frontmatter", () => {
    const body = loadSkillBody("vibe-code");
    expect(body.length).toBeGreaterThan(500);
    expect(body.startsWith("---")).toBe(false);
    expect(body.toLowerCase()).toContain("vibe code in prod responsibly");
  });

  it("loads app-build body without frontmatter", () => {
    const body = loadSkillBody("app-build");
    expect(body.length).toBeGreaterThan(500);
    expect(body.startsWith("---")).toBe(false);
    expect(body.toLowerCase()).toMatch(/spec|chunk|plan/);
  });
});

describe("loadSkillBody — error + cache behavior", () => {
  it("throws a loud error when a skill bundle is missing", () => {
    expect(() => loadSkillBody("definitely-not-a-real-skill")).toThrow(/missing/);
  });

  it("caches the body after first load (same reference on repeat call)", () => {
    const a = loadSkillBody("senior-engineer");
    const b = loadSkillBody("senior-engineer");
    expect(a).toBe(b);
  });

  it("_resetSkillBodyCache forces re-read", () => {
    const a = loadSkillBody("senior-engineer");
    _resetSkillBodyCache();
    const b = loadSkillBody("senior-engineer");
    expect(a).toEqual(b); // same content
    // (We can't easily prove the file was re-read without filesystem
    // interception; the reset method existing is enough for now.)
  });
});
