// A tool's description says what the tool does. Whether a setting has
// switched it off is the tool's own result when called (it returns a blocked
// result that says so), never a line in the description: the model reads the
// description as instructions and checks the setting itself.
//
// label-check-grok's owner, 2026-11-27: start_app_build said "Gated behind
// LAX_AUTO_BUILD_ENABLED env flag." The flag is opt-out (building is on unless
// it is set to 0/false/off), so Grok ran `echo $LAX_AUTO_BUILD_ENABLED`, read
// "unset" as "off", and spent two turns of thirty calls saying "Calling the
// greenfield entrypoint now" while calling `bash echo` instead, until the
// repeat guard ended the turn.
import { beforeAll, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../types.js";
import { collectRuntimeTools } from "./runtime-tool-names.js";

let tools: Map<string, ToolDefinition>;

beforeAll(async () => {
  tools = await collectRuntimeTools();
}, 60_000);

const SETTING = /\b(?:LAX|PRIMAL)_[A-Z0-9_]+\b|\benv(?:ironment)? (?:flag|var(?:iable)?)\b/;

describe("tool descriptions name no settings", () => {
  it("no runtime tool's description names a LAX setting or an env flag", () => {
    expect(tools.size).toBeGreaterThan(100);
    const naming = [...tools.values()]
      .filter((t) => SETTING.test(t.description ?? ""))
      .map((t) => `${t.name}: ${(t.description ?? "").match(SETTING)![0]}`);
    expect(naming, "move the switch into the tool's blocked result, not its description").toEqual([]);
  });
});
