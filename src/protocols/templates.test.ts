// protocol(action:"from_template") built a Protocol object and returned
// "Created ..." without ever saving it: nothing in custom.json, nothing for
// protocol(action:"get"). It must persist through the same authoring path as
// protocol(action:"create").
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRuntimeConfig, setRuntimeConfig } from "../config.js";
import type { LAXConfig } from "../types.js";
import { customProtocolsPath, getProtocol, saveCustomProtocols } from "./builder.js";
import { createTemplateTools } from "./templates.js";

let TEMP: string;
let ORIGINAL_CFG: LAXConfig;

beforeAll(() => {
  TEMP = mkdtempSync(join(tmpdir(), "lax-protocol-templates-"));
  ORIGINAL_CFG = getRuntimeConfig();
  setRuntimeConfig({ ...ORIGINAL_CFG, workspace: TEMP } as LAXConfig);
});
afterAll(() => {
  setRuntimeConfig(ORIGINAL_CFG);
  rmSync(TEMP, { recursive: true, force: true });
});
beforeEach(() => { saveCustomProtocols([]); });

const fromTemplate = () => createTemplateTools().find(t => t.name === "protocol_from_template")!;

describe("protocol_from_template", () => {
  it("saves the protocol to the custom catalog", async () => {
    const res = await fromTemplate().execute({
      templateId: "research",
      name: "Competitor Scan",
      triggers: ["scan competitors"],
      extraRules: ["Never cite a source older than a year."],
    });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('Created protocol "Competitor Scan"');

    const saved = getProtocol("Competitor Scan");
    expect(saved).toBeDefined();
    expect(saved!.triggers).toEqual(["scan competitors"]);
    expect(saved!.rules).toContain("Never cite a source older than a year.");
    expect(saved!.steps.map(s => s.id)).toContain("synthesize");
    expect(customProtocolsPath().startsWith(TEMP)).toBe(true);
  });

  it("refuses a name that already exists instead of reporting a second creation", async () => {
    await fromTemplate().execute({ templateId: "developer", name: "Ship It" });
    const again = await fromTemplate().execute({ templateId: "developer", name: "Ship It" });
    expect(again.isError).toBe(true);
    expect(again.content).toMatch(/already exists|too similar/);
  });

  it("rejects an unknown template as an error", async () => {
    const res = await fromTemplate().execute({ templateId: "nope", name: "X" });
    expect(res.isError).toBe(true);
  });
});
