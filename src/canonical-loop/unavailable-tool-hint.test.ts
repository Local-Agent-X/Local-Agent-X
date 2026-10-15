import { describe, it, expect } from "vitest";
import { noteUnavailableTools, unavailableToolsNamed } from "./unavailable-tool-hint.js";

const TOOLS = new Set(["delete_file", "http_request", "bulk_replace", "grep", "edit", "read", "write", "bash"]);
const isTool = (n: string) => TOOLS.has(n);
// The app_build worker's belt on 2026-10-14: write/read/edit/bash, no delete_file.
const workerCan = (n: string) => ["write", "read", "edit", "bash", "http_request"].includes(n);

describe("noteUnavailableTools", () => {
  it("names the suggested tool the worker can't call (the rm refusal it got)", () => {
    const refusal = "[blocked]\nRecovery: Delete them with delete_file instead — it moves files to the trash.";
    const out = noteUnavailableTools(refusal, isTool, workerCan);
    expect(out.startsWith(refusal)).toBe(true);
    expect(out).toContain("Not available in this run: delete_file.");
  });

  it("leaves advice the run can follow alone", () => {
    const refusal = "[blocked]\nRecovery: use http_request instead of curl.";
    expect(noteUnavailableTools(refusal, isTool, workerCan)).toBe(refusal);
  });

  it("counts backticked names and underscore names, not English words", () => {
    expect(unavailableToolsNamed("Run `grep` or bulk_replace; read the file and edit it.", isTool, workerCan)).toEqual(["grep", "bulk_replace"]);
  });

  it("ignores names that are not registered tools, and reports each once", () => {
    expect(unavailableToolsNamed("see some_function and delete_file, then delete_file again", isTool, () => false)).toEqual(["delete_file"]);
  });
});
