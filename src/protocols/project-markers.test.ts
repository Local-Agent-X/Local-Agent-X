import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRuntimeConfig, getRuntimeConfig } from "../config.js";
import type { LAXConfig } from "../types.js";
import { parseSkillMd } from "./skill-md-parser.js";
import { projectDirsNamedIn, projectMarkerHitIn } from "./project-markers.js";
import { selectLearnedProtocolSuggestion } from "./learned-suggestion.js";
import { importedProtocolsDir, loadImportedProtocols } from "./loader.js";
import type { Protocol } from "./types.js";

const SUPABASE_SKILL = `---
name: supabase-migrations
description: Change a Supabase project's database schema the supported way — a SQL migration file under supabase/migrations, never a live connection.
triggers: [supabase, add a table, database migration, schema change, create table]
project-markers: [supabase/config.toml]
license: Apache-2.0
---
Schema lives in supabase/migrations.
`;
const MESSAGE = "In the acme-api project, add a customers table with id, email and created_at columns.";
const noLoad = (): never => { throw new Error("no record"); };

let TEMP: string;
let TEMP_LAX: string;
let ORIGINAL: LAXConfig;
let ORIGINAL_LAX_DATA_DIR: string | undefined;
beforeAll(() => {
  TEMP = mkdtempSync(join(tmpdir(), "lax-project-markers-"));
  TEMP_LAX = mkdtempSync(join(tmpdir(), "lax-project-markers-laxdir-"));
  ORIGINAL = getRuntimeConfig();
  setRuntimeConfig({ ...ORIGINAL, workspace: TEMP } as LAXConfig);
  ORIGINAL_LAX_DATA_DIR = process.env.LAX_DATA_DIR;
  process.env.LAX_DATA_DIR = TEMP_LAX;
  mkdirSync(join(TEMP, "acme-api", "supabase", "migrations"), { recursive: true });
  writeFileSync(join(TEMP, "acme-api", "supabase", "config.toml"), 'project_id = "acme-api"\n');
  mkdirSync(join(TEMP, "acme-site"), { recursive: true });
  writeFileSync(join(TEMP, "acme-site", "vercel.json"), "{}");
});
afterAll(() => {
  setRuntimeConfig(ORIGINAL);
  if (ORIGINAL_LAX_DATA_DIR === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = ORIGINAL_LAX_DATA_DIR;
  rmSync(TEMP, { recursive: true, force: true });
  rmSync(TEMP_LAX, { recursive: true, force: true });
});

describe("project-markers frontmatter", () => {
  it("parses the list and drops anything absolute or climbing", () => {
    const p = parseSkillMd(SUPABASE_SKILL, { source: { type: "imported" } })!;
    expect(p.projectMarkers).toEqual(["supabase/config.toml"]);
    const messy = parseSkillMd(SUPABASE_SKILL.replace("[supabase/config.toml]", "[./vercel.json, /etc/passwd, ../secret, C:/x, supabase\\config.toml]"), { source: { type: "imported" } })!;
    expect(messy.projectMarkers).toEqual(["vercel.json", "supabase/config.toml"]);
    expect(parseSkillMd("---\nname: x\ndescription: d\n---\nbody", { source: { type: "imported" } })!.projectMarkers).toBeUndefined();
  });
});

describe("projectDirsNamedIn", () => {
  it("is the workspace root plus the directories the message names, and nothing it does not", () => {
    const dirs = projectDirsNamedIn(MESSAGE, TEMP);
    expect(dirs).toEqual([TEMP, join(TEMP, "acme-api")]);
    expect(projectDirsNamedIn("deploy acme-site now", TEMP)).toEqual([TEMP, join(TEMP, "acme-site")]);
    expect(projectDirsNamedIn("read ../../etc and .git please", TEMP)).toEqual([TEMP]);
  });
});

describe("a project marker admits a skill the wording alone would not", () => {
  const skill = (): Protocol => ({
    ...parseSkillMd(SUPABASE_SKILL, { source: { type: "imported", origin: "workspace" } })!,
  });

  it("without a marker hit the supabase message is not admitted (the EXP-15 result)", () => {
    expect(selectLearnedProtocolSuggestion(MESSAGE, [], [skill()], noLoad)).toBeNull();
    expect(selectLearnedProtocolSuggestion(MESSAGE, [], [skill()], noLoad, { projectMarkerHit: () => false })).toBeNull();
  });

  it("with the marker on disk in the named project it is admitted", () => {
    const hit = projectMarkerHitIn(projectDirsNamedIn(MESSAGE, TEMP));
    expect(hit(skill())).toBe(true);
    expect(selectLearnedProtocolSuggestion(MESSAGE, [], [skill()], noLoad, { projectMarkerHit: hit })?.name).toBe("supabase-migrations");
  });

  it("a marker that is not there, or a message naming a project without it, does not admit", () => {
    // Same wording as MESSAGE (which the term gate rejects); only the project differs.
    const other = MESSAGE.replace("acme-api", "acme-site");
    const elsewhere = projectMarkerHitIn(projectDirsNamedIn(other, TEMP));
    expect(elsewhere(skill())).toBe(false);
    expect(selectLearnedProtocolSuggestion(other, [], [skill()], noLoad, { projectMarkerHit: elsewhere })).toBeNull();
  });

  it("a skill without markers is untouched by the predicate", () => {
    const plain = { ...skill(), projectMarkers: undefined };
    expect(selectLearnedProtocolSuggestion(MESSAGE, [], [plain], noLoad, { projectMarkerHit: () => true })).toBeNull();
  });

  it("end to end through the loader and the real workspace lookup", async () => {
    mkdirSync(join(importedProtocolsDir(), "supabase-migrations"), { recursive: true });
    writeFileSync(join(importedProtocolsDir(), "supabase-migrations", "SKILL.md"), SUPABASE_SKILL);
    const loaded = loadImportedProtocols().find((p) => p.name === "supabase-migrations")!;
    expect(loaded.projectMarkers).toEqual(["supabase/config.toml"]);
    const { getLearnedProtocolSuggestion } = await import("./learned-suggestion.js");
    expect(getLearnedProtocolSuggestion(MESSAGE)?.name).toBe("supabase-migrations");
    expect(getLearnedProtocolSuggestion("In the acme-site project, add a customers table with id, email and created_at columns.")).toBeNull();
  });
});
