// What plan mode permits is read off each tool's policy row, not a list of
// names: a tool's risk tier, and for the call its paths, its kernel action and
// where it delivers. The cases a name list got right stay right; the ones it
// could not express (a browser click, a send to the user's phone, a family's
// read action) are decided by the facts that make them writes or reads.
import { describe, expect, it } from "vitest";
import { isReadOnlyCall } from "./plan-tools.js";
import { CREATE_CLASS } from "../tool-execution/create-target-path.js";
import { createTargetPath } from "../tool-execution/create-target-path.js";
import { CONTEXT_RESTRICTED_TOOLS } from "../security/layer/index.js";
import { WHOLE_TOOL_GRANTS } from "../approval-decision.js";
import { TOOLS } from "../tool-registry.js";

describe("plan mode's read-only verdict comes from the row", () => {
  it("reads: files, the web, mail, memory, status and the plan tools themselves", () => {
    for (const name of ["read", "grep", "glob", "web_search", "web_fetch", "view_image", "sql_schema", "clipboard_read",
      "calendar_list_events", "email_read", "email_read_message", "email_folders", "enter_plan_mode", "exit_plan_mode",
      "task_list", "tool_search", "ask_user", "memory_search", "process_status", "agent_whoami", "issue_list"]) {
      expect(isReadOnlyCall(name, {}), name).toBe(true);
    }
  });

  it("writes: files, mail, the calendar, messages, and a tool with no row", () => {
    for (const name of ["write", "edit", "delete_file", "email_delete", "email_mark", "calendar_create_event", "email_send",
      "telegram_send", "issue_create", "task_create", "bash", "android", "mcp_some_server_tool", "no_such_tool"]) {
      expect(isReadOnlyCall(name, {}), name).toBe(false);
    }
  });

  it("a browser navigate reads the web; a click, fill or script writes to a page", () => {
    expect(isReadOnlyCall("browser", { action: "navigate", url: "https://example.com" })).toBe(true);
    expect(isReadOnlyCall("browser", { action: "read" })).toBe(true);
    for (const action of ["click", "fill", "type", "evaluate", "act"]) expect(isReadOnlyCall("browser", { action }), action).toBe(false);
  });

  it("a send to the user's device is a delivery, whatever its risk tier", () => {
    for (const name of ["send_file", "send_image", "send_video"]) {
      expect(TOOLS[name].risk).toBe("safe");
      expect(isReadOnlyCall(name, { path: "x" }), name).toBe(false);
    }
  });

  it("a collapsed family is judged by the call's action, by its own path specs", () => {
    expect(isReadOnlyCall("spreadsheet", { action: "read" })).toBe(true);
    expect(isReadOnlyCall("spreadsheet", { action: "query" })).toBe(true);
    expect(isReadOnlyCall("spreadsheet", { action: "write" })).toBe(false);
    expect(isReadOnlyCall("document", { action: "read" })).toBe(true);
    expect(isReadOnlyCall("document", { action: "create" })).toBe(false);
    expect(isReadOnlyCall("pdf", { action: "extract_tables" })).toBe(true);
    expect(isReadOnlyCall("pdf", { action: "merge" })).toBe(false);
    expect(isReadOnlyCall("presentation", { action: "create" })).toBe(false);
    expect(isReadOnlyCall("document", {})).toBe(false); // an action the specs don't name is refused
  });

  it("sql_query reads unless readonly is false, as its row says", () => {
    expect(isReadOnlyCall("sql_query", { sql: "select 1" })).toBe(true);
    expect(isReadOnlyCall("sql_query", { sql: "delete from t", readonly: false })).toBe(false);
  });
});

describe("the other row-declared facts the gates read", () => {
  it("a scheduled job gets no browser and no image generation, as the rows say", () => {
    expect(CONTEXT_RESTRICTED_TOOLS).toEqual({ browser: ["cron"], generate_image: ["cron"], edit_image: ["cron"] });
  });

  it("an always-allow covers the whole tool only for LAX's own bookkeeping", () => {
    expect([...WHOLE_TOOL_GRANTS].sort()).toEqual(["sidebar_clear", "sidebar_pin", "sidebar_unpin", "task_create", "task_update"]);
  });

  it("the create class is every tool with a write path spec, and the target is that spec's path", () => {
    expect([...CREATE_CLASS].sort()).toEqual(expect.arrayContaining(["write", "spreadsheet", "document", "pdf", "presentation", "create_chart", "extract_site_assets"]));
    expect(CREATE_CLASS.has("read")).toBe(false);
    expect(createTargetPath("document", { action: "template", template_path: "t.docx", output_path: "out.docx" })).toMatch(/out\.docx$/);
    expect(createTargetPath("document", { action: "read", file_path: "a.docx" })).toBeNull();
    expect(createTargetPath("pdf", { action: "merge", files: '["a.pdf"]', output_path: "m.pdf" })).toMatch(/m\.pdf$/);
    expect(createTargetPath("presentation", { action: "edit", file_path: "d.pptx" })).toBeNull();
    expect(createTargetPath("spreadsheet", { action: "write", file_path: "s.xlsx" })).toMatch(/s\.xlsx$/);
  });

  it("calendar_create_event is a local write the kernel never sees", () => {
    expect(TOOLS.calendar_create_event.kernel).toBe("internal");
  });
});
