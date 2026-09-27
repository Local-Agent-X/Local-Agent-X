// A skill's reference files are served by protocol(action:"get", file) — and
// nothing outside that one skill's folder is.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSkillFile, skillFiles } from "./skill-files.js";
import { loadVendorProtocols } from "./vendor-packs.js";

const dir = mkdtempSync(join(tmpdir(), "lax-skill-files-"));
const skill = join(dir, "wrangler");
mkdirSync(join(skill, "references"), { recursive: true });
writeFileSync(join(skill, "SKILL.md"), "---\nname: wrangler\n---\nSee references/config.md");
writeFileSync(join(skill, "references", "config.md"), "compatibility_date goes in wrangler.jsonc");
writeFileSync(join(dir, "secret.txt"), "outside the skill");
const skillMd = join(skill, "SKILL.md");

describe("skill files", () => {
  it("lists the files beside SKILL.md, not SKILL.md itself", () => {
    expect(skillFiles(skillMd)).toEqual(["references/config.md"]);
  });

  it("reads a file inside the skill, with either slash", () => {
    expect(readSkillFile(skillMd, "references/config.md")).toEqual({ text: "compatibility_date goes in wrangler.jsonc" });
    expect(readSkillFile(skillMd, "references\\config.md")).toEqual({ text: "compatibility_date goes in wrangler.jsonc" });
  });

  it("refuses anything outside the skill's folder, and names what exists when a file is missing", () => {
    expect(readSkillFile(skillMd, "../secret.txt")).toMatchObject({ error: expect.stringMatching(/outside/) });
    expect(readSkillFile(skillMd, join(dir, "secret.txt"))).toMatchObject({ error: expect.stringMatching(/outside/) });
    expect(readSkillFile(skillMd, "references/missing.md")).toMatchObject({ error: expect.stringMatching(/references\/config\.md/) });
  });

  it("a shipped vendor skill that points into its references can serve them", () => {
    const cf = loadVendorProtocols().find((s) => s.name === "cloudflare");
    expect(cf?.source?.sourcePath).toBeTruthy();
    const files = skillFiles(cf!.source!.sourcePath!);
    expect(files.length).toBeGreaterThan(5);
    expect("text" in readSkillFile(cf!.source!.sourcePath!, files[0])).toBe(true);
  });
});
