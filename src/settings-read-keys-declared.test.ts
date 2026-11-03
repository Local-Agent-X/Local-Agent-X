import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { settingSpec } from "./settings-schema.js";

// A setting the code reads by name but the schema never declares can't be set
// through POST /api/settings or the agent's setting tool ("No such setting"),
// so the only way to change it is hand-editing settings.json with the app
// quit. That is how `voiceModel` sat unreachable: voice-model.ts documented
// "chat" as the way to talk to the full chat model, and nothing could set it.
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "vendor" ? [] : sourceFiles(p);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [p] : [];
  });
}

describe("settings read by name", () => {
  it("are all declared in the settings schema", () => {
    const undeclared: string[] = [];
    for (const file of sourceFiles(join(process.cwd(), "src"))) {
      for (const m of readFileSync(file, "utf8").matchAll(/getSetting(?:<[^>]*>)?\("([A-Za-z0-9_]+)"/g)) {
        if (!settingSpec(m[1])) undeclared.push(`${m[1]} (${file.slice(process.cwd().length + 1)})`);
      }
    }
    expect(undeclared).toEqual([]);
  });
});
