// A command's output is one channel, whichever tool hands it back. The process
// tools (a dev server's stdout, a background command's line) used to be masked
// for registered values only, like a source file the model is editing, so a
// server printing `API_KEY=…` reached the model whole while the same line from
// bash was masked.
import { afterEach, describe, expect, it } from "vitest";
import { maskDeliveredSecrets } from "./sensitive-read-taint.js";
import { unregisterRedactedSecretValue } from "../security/secrets/index.js";

const used: string[] = [];
const keyLine = (n: number) => {
  const value = `${n}a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6`.slice(0, 32);
  used.push(value);
  return { value, line: `server ready\nAPI_KEY=${value}\nlistening on 5173` };
};
afterEach(() => { for (const v of used.splice(0)) unregisterRedactedSecretValue(v); });

describe("command output gets the same mask as bash, whichever tool returns it", () => {
  it("masks a credential in process output", () => {
    ["bash", "process_status", "process_list", "process_start", "process_restart"].forEach((tool, i) => {
      const { value, line } = keyLine(i + 1);
      const out = maskDeliveredSecrets(tool, {}, { content: line });
      expect(out.content, tool).not.toContain(value);
      expect(out.content, tool).toContain("listening on 5173");
    });
  });

  it("still leaves a credential-shaped string in a file the model is reading", () => {
    const { value, line } = keyLine(9);
    expect(maskDeliveredSecrets("read", { path: "fixtures/env.example" }, { content: line }).content).toContain(value);
  });
});
