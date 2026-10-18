// What plan mode permits is read off each tool's policy row, not a list of
// names: a tool's risk tier, and for the call its paths, its kernel action and
// where it delivers. The cases a name list got right stay right; the ones it
// could not express (a browser click, a send to the user's phone, a family's
// read action) are decided by the facts that make them writes or reads.
import { afterEach, describe, expect, it } from "vitest";
import { isReadOnlyCall } from "./plan-tools.js";
import { CREATE_CLASS } from "../tool-execution/create-target-path.js";
import { createTargetPath } from "../tool-execution/create-target-path.js";
import { CONTEXT_RESTRICTED_TOOLS } from "../security/layer/index.js";
import { WHOLE_TOOL_GRANTS } from "../approval-decision.js";
import { TOOLS } from "../tool-registry.js";
import { TOOL_POLICIES } from "../tool-policy/tool-policies.data.js";
import type { DestinationSpec, ToolPolicyRow } from "../tool-policy/tool-policies.types.js";

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
      "telegram_send", "whatsapp_send", "issue_create", "task_create", "bash", "android", "mcp_some_server_tool", "no_such_tool"]) {
      expect(isReadOnlyCall(name, {}), name).toBe(false);
    }
  });

  it("a browser navigate reads the web; a click, fill or script writes to a page", () => {
    expect(isReadOnlyCall("browser", { action: "navigate", url: "https://example.com" })).toBe(true);
    expect(isReadOnlyCall("browser", { action: "read" })).toBe(true);
    for (const action of ["click", "fill", "type", "evaluate", "act"]) expect(isReadOnlyCall("browser", { action }), action).toBe(false);
  });

  it("a send to the user's own device is part of planning: a plan, mockup or diagram may reach them", () => {
    for (const name of ["send_file", "send_image", "send_video"]) {
      expect(TOOLS[name].risk).toBe("safe");
      expect(TOOL_POLICIES[name].destination).toEqual([{ to: "user", message: true }]);
      expect(isReadOnlyCall(name, { path: "x" }), name).toBe(true);
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

// The sends' verdict is keyed on the row's `destination`, never on the name:
// the same send-shaped row (a safe, kernel-read file read that ships its
// content off-box) is admitted when it reaches only the user and refused when
// it reaches anyone else. Real rows prove less — every send to a person is
// also external-comms and a kernel post, so those facts would refuse it first.
describe("plan mode keys a send on where its row says it delivers", () => {
  const PROBE = "plan_probe_send";
  const sendShaped = (destination?: DestinationSpec[], ariAction: "read" | "post" = "read"): ToolPolicyRow =>
    ({ kernel: "file", ariAction, risk: "safe", capabilities: ["egress"], tags: [], offBoxFetch: true, ...(destination ? { destination } : {}) });
  afterEach(() => { delete TOOL_POLICIES[PROBE]; });

  it("admits a send to the user, and refuses the same row sent to a recipient, a chat, or somewhere it cannot name", () => {
    TOOL_POLICIES[PROBE] = sendShaped([{ to: "user" }]);
    expect(isReadOnlyCall(PROBE, { path: "plan.md" })).toBe(true);
    TOOL_POLICIES[PROBE] = sendShaped([{ to: "recipients", args: ["to"] }]);
    expect(isReadOnlyCall(PROBE, { path: "plan.md", to: "someone@example.com" })).toBe(false);
    TOOL_POLICIES[PROBE] = sendShaped([{ to: "chat", app: "Telegram", arg: "chat_id" }]);
    expect(isReadOnlyCall(PROBE, { path: "plan.md" })).toBe(false);
    TOOL_POLICIES[PROBE] = sendShaped([{ to: "unknown", label: "an app on the device" }]);
    expect(isReadOnlyCall(PROBE, { path: "plan.md" })).toBe(false);
  });

  it("a destination scoped to an action decides that action; the user spec is no credit for the others", () => {
    TOOL_POLICIES[PROBE] = sendShaped([{ to: "user", forActions: ["preview"] }, { to: "recipients", args: ["to"], forActions: ["send"] }]);
    expect(isReadOnlyCall(PROBE, { action: "preview" })).toBe(true);
    expect(isReadOnlyCall(PROBE, { action: "send", to: "someone@example.com" })).toBe(false);
  });

  it("a row with no destination earns nothing from this clause: its other facts alone decide", () => {
    // Same facts as view_image, which ships an image to the vision API and is
    // a read; a destination-less row that posts stays refused by its action.
    TOOL_POLICIES[PROBE] = sendShaped();
    expect(isReadOnlyCall(PROBE, { path: "plan.md" })).toBe(true);
    TOOL_POLICIES[PROBE] = sendShaped(undefined, "post");
    expect(isReadOnlyCall(PROBE, { path: "plan.md" })).toBe(false);
  });
});

describe("the other row-declared facts the gates read", () => {
  it("no row denies a tool by call context: a scheduled job browses and makes images, gated per call", () => {
    expect(CONTEXT_RESTRICTED_TOOLS).toEqual({});
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

  it("the calendar tools read and write calendar.json: local, never the kernel's http class", () => {
    for (const name of ["calendar_check_availability", "calendar_list_events", "calendar_create_event"]) {
      expect(TOOLS[name].kernel, name).toBe("internal");
    }
  });
});
