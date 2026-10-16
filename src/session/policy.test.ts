import { describe, expect, it } from "vitest";
import { CAPABILITY_CLASS_MEMBERS } from "../tool-registry.js";
import { checkSessionPolicy, getSessionPolicy, setSessionPolicy } from "./policy.js";

// A preset blocks capability CLASSES, judged per call, so every synonym of a
// blocked tool is blocked with it. The old hand-written lists blocked `write`
// and `edit` but not edit_lines / multi_edit / bulk_replace / delete_file, and
// `bash` but not process_start (found 2026-07-29); the name-level class let a
// document tool's write through, and would have refused its read.
describe("session policy presets block capability classes, not tool names", () => {
  it("read-only blocks every shell, egress and file-writing call", () => {
    setSessionPolicy("s-read-only", "read-only");
    for (const tool of [...CAPABILITY_CLASS_MEMBERS.shell, ...CAPABILITY_CLASS_MEMBERS.egress]) {
      expect(checkSessionPolicy("s-read-only", tool), tool).toMatch(/Blocked by session policy \(read-only\)/);
    }
    for (const tool of ["write", "edit", "edit_lines", "multi_edit", "bulk_replace", "delete_file", "restore_file"]) {
      expect(checkSessionPolicy("s-read-only", tool, { path: "notes.md" }), tool).toMatch(/writes files/);
    }
    expect(checkSessionPolicy("s-read-only", "read", { path: "notes.md" })).toBeNull();
  });

  it("read-only judges each call: a document tool's write is refused, its read is not", () => {
    setSessionPolicy("s-read-only-docs", "read-only");
    expect(checkSessionPolicy("s-read-only-docs", "spreadsheet", { action: "write", file_path: "a.xlsx" })).toMatch(/writes files/);
    expect(checkSessionPolicy("s-read-only-docs", "pdf", { action: "create", file_path: "a.pdf" })).toMatch(/writes files/);
    expect(checkSessionPolicy("s-read-only-docs", "spreadsheet", { action: "read", file_path: "a.xlsx" })).toBeNull();
    expect(checkSessionPolicy("s-read-only-docs", "ari_file", { action: "read", path: "a.txt" })).toBeNull();
    expect(checkSessionPolicy("s-read-only-docs", "ari_file", { action: "write", path: "a.txt" })).toMatch(/writes files/);
  });

  it("high-security blocks shell and egress but leaves writes", () => {
    setSessionPolicy("s-high", "high-security");
    for (const tool of [...CAPABILITY_CLASS_MEMBERS.shell, ...CAPABILITY_CLASS_MEMBERS.egress]) {
      expect(checkSessionPolicy("s-high", tool), tool).toMatch(/high-security/);
    }
    expect(checkSessionPolicy("s-high", "write", { path: "notes.md" })).toBeNull();
  });

  it("default and dev-mode block nothing", () => {
    expect(getSessionPolicy("nobody").blockedClasses).toEqual([]);
    setSessionPolicy("s-dev", "dev-mode");
    expect(checkSessionPolicy("s-dev", "bash", { command: "ls" })).toBeNull();
  });
});
