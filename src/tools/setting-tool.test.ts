import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingTool } from "./setting-tool.js";
import { FLIPPABLE_SETTINGS } from "../settings-schema.js";
import { reloadSettings, settingsPath } from "../settings.js";
import type { ToolResult } from "../types.js";

// The `setting` tool and POST /api/settings read who owns a setting from the
// same declaration (settings-schema.ts); the tool is always the agent.

const operatorOwned = FLIPPABLE_SETTINGS.flatMap((s) => (s.owner === "operator" ? [[s.field, s.where]] : []));
const run = (field: string, value: unknown) => settingTool.execute({ field, value }) as Promise<ToolResult>;
const disk = () => (existsSync(settingsPath()) ? readFileSync(settingsPath(), "utf-8") : "");

describe("setting tool", () => {
  let dir = "";
  const prev = process.env.LAX_DATA_DIR;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lax-setting-tool-"));
    process.env.LAX_DATA_DIR = dir;
    reloadSettings();
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.LAX_DATA_DIR;
    else process.env.LAX_DATA_DIR = prev;
    reloadSettings();
    rmSync(dir, { recursive: true, force: true });
  });

  it("knows the operator-owned settings", () => {
    expect(operatorOwned.length).toBeGreaterThan(0);
  });

  it.each(operatorOwned)("refuses %s, names %s, and saves nothing", async (field, where) => {
    const before = disk();
    const r = await run(field, field === "port" ? 7999 : "x");
    expect(r.status).toBe("blocked");
    expect(r.content).toContain(`Only the user can change ${field}`);
    expect(r.content).toContain(where);
    expect(disk()).toBe(before);
  });

  it("leaves operator-owned settings out of the field list it offers", async () => {
    const r = await run("?", undefined);
    for (const [field] of operatorOwned) expect(r.content).not.toMatch(new RegExp(`- ${field}\\b`));
  });

  it("applies an agent-owned UI preference", async () => {
    const r = await run("palette", "bloom");
    expect(r.isError).toBeFalsy();
    expect(reloadSettings().palette).toBe("bloom");
  });

  it("refuses a field no setting declares", async () => {
    const r = await run("madeUpSetting", true);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('Unknown setting field "madeUpSetting"');
  });
});
