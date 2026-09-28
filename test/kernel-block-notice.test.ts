// @vitest-environment happy-dom
//
// The notice the user was never shown.
//
// A kernel quarantine's only control was a chip appended INSIDE the blocked
// call's card, inside the collapsible "Agent activity" group — whose body is
// display:none until the user expands it — and it was built from live event
// metadata the server never persisted, so a reload or hydrate dropped it. The
// model, meanwhile, was told to say "click Declassify & retry on this card"
// (2026-09-27 21:33, session chat-mukgvypc-r1tbc).
//
// These drive the REAL row renderer (_renderAssistantToolArtifacts) with the
// exact metadata shapes the policy layer emits and the exact `_tools` shape the
// server projection rebuilds on reload, and assert the notice lands on the row
// OUTSIDE the group — with the button only when the block is clearable.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { projectSessionForUI } from "../src/memory/session-ui-projection.js";
import type { Session } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const g = globalThis as unknown as Record<string, unknown>;

type ToolEvent = { type: "start" | "end"; name: string; toolCallId?: string; args?: Record<string, unknown>; status?: string; result?: string; metadata?: Record<string, unknown> };
type Artifacts = { _renderAssistantToolArtifacts: (body: HTMLElement, data: { toolEvents: ToolEvent[] }) => void };

const load = <T>(file: string, ret: string): T => {
  const src = readFileSync(join(here, "../public/js/" + file), "utf8");
  // eslint-disable-next-line no-new-func
  return new Function(`${src}; return ${ret};`)() as T;
};

let artifacts: Artifacts;

beforeEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  g.esc = (s: unknown) => String(s ?? "").replace(/</g, "&lt;");
  g.apiPost = async () => ({ ok: true, cleared: 1 });
  g.activeChat = { id: "chat-mukgvypc-r1tbc" };
  console.error = (...a: unknown[]) => { throw new Error("render error: " + a.map(String).join(" ")); };
  Object.assign(g, load<object>("chat-tool-cards.js", "{ appendToolCardGrouped, attachMediaPreview, toolSummary }"));
  Object.assign(g, load<object>("chat-declassify-action.js", "{ isDeclassifiable, isKernelBlockNotice, renderKernelBlockNotice, appendDeclassifyAction }"));
  artifacts = load<Artifacts>("chat-render-artifacts.js", "{ _renderAssistantToolArtifacts }");
});

function render(toolEvents: ToolEvent[]): HTMLElement {
  const body = document.createElement("div");
  document.body.appendChild(body);
  artifacts._renderAssistantToolArtifacts(body, { toolEvents });
  return body;
}

// A block as the policy layer now emits it: a run rule refused ONE call, and
// the turn goes on.
const RUN_RULE_BLOCK: ToolEvent[] = [
  { type: "start", name: "write", toolCallId: "a", args: { path: "proj/.env" } },
  { type: "end", name: "write", toolCallId: "a", status: "ok", result: "[ok]" },
  { type: "start", name: "http_request", toolCallId: "b", args: { url: "https://api.supabase.com/v1/projects/x/database/query", method: "POST" } },
  {
    type: "end", name: "http_request", toolCallId: "b", status: "blocked",
    result: "[blocked, layer=\"arikernel\", rule=\"sensitive_read_then_egress\"]\nBLOCKED by ARI kernel: ...",
    metadata: {
      layer: "arikernel", rule: "sensitive_read_then_egress", trigger: "behavioral_rule", scope: "operation",
      quarantine: { trigger: "behavioral_rule", rule: "sensitive_read_then_egress", reason: "Read of proj/.env was followed by outbound post attempt", deniedActions: 1, threshold: 5 },
    },
  },
];

describe("the security-block notice is on the row, not in the collapsed group", () => {
  it("a run-rule refusal renders a notice outside .activity-group, naming the rule and the call, with no button", () => {
    const body = render(RUN_RULE_BLOCK);
    const notice = body.querySelector(".kernel-block-notice") as HTMLElement | null;
    expect(notice).not.toBeNull();
    // Direct child of the row body — a sibling of the group, never inside it.
    expect(notice!.parentElement).toBe(body);
    expect(notice!.closest(".activity-group")).toBeNull();
    // The group it would have been buried in is collapsed by default.
    const group = body.querySelector(".activity-group")!;
    expect(group.classList.contains("open")).toBe(false);
    expect(notice!.textContent).toContain("sensitive_read_then_egress");
    expect(notice!.textContent).toContain("refused http_request");
    expect(notice!.textContent).toMatch(/Only that call was refused; the turn continues/);
    expect(notice!.textContent).toContain("Refusal 1 of 5");
    expect(notice!.querySelector("button")).toBeNull();
    // The activity header counts it.
    expect(group.querySelector(".activity-label")!.textContent).toContain("1 blocked");
  });

  it("a restricted-mode cascade says the turn is paused and ends with it", () => {
    const body = render([
      { type: "start", name: "bash", toolCallId: "c", args: { command: "echo ok" } },
      {
        type: "end", name: "bash", toolCallId: "c", status: "blocked", result: "[blocked, layer=\"arikernel\", trigger=\"restricted\"]\n...",
        metadata: {
          layer: "arikernel", rule: "sensitive_read_then_egress", trigger: "restricted", scope: "operation",
          quarantine: { trigger: "restricted", rule: "sensitive_read_then_egress", reason: "Denied actions (5) reached the threshold (5); the last was refused by run rule sensitive_read_then_egress", restrictedAt: "2026-09-28T02:51:15.277Z", deniedActions: 5 },
        },
      },
    ]);
    const notice = body.querySelector(".kernel-block-notice")!;
    expect(notice.textContent).toMatch(/paused this turn/);
    expect(notice.textContent).toMatch(/next message starts clean/);
    expect(notice.querySelector("button")).toBeNull();
  });

  it("a clearable (taint) block renders the notice WITH the Declassify & retry button", () => {
    const body = render([
      { type: "start", name: "http_request", toolCallId: "c", args: {} },
      { type: "end", name: "http_request", toolCallId: "c", status: "blocked", result: "[blocked, layer=\"data-lineage\", clearable=\"declassify\"]\n...", metadata: { layer: "data-lineage", clearable: "declassify" } },
    ]);
    const notice = body.querySelector(".kernel-block-notice")!;
    expect(notice.parentElement).toBe(body);
    const btn = notice.querySelector("button")!;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toContain("Declassify & retry");
  });

  it("a block the user cannot clear at all (canary, allowlist) gets no notice", () => {
    const body = render([
      { type: "start", name: "http_request", toolCallId: "d", args: {} },
      { type: "end", name: "http_request", toolCallId: "d", status: "blocked", result: "[blocked, layer=\"canary\"]\n...", metadata: { layer: "canary" } },
    ]);
    expect(body.querySelector(".kernel-block-notice")).toBeNull();
  });

  it("the re-surfaced control (show_unblock_control) renders the same notice from an ok result", () => {
    const body = render([
      { type: "start", name: "show_unblock_control", toolCallId: "e", args: {} },
      { type: "end", name: "show_unblock_control", toolCallId: "e", status: "ok", result: "[ok, layer=\"quarantine-notice\", clearable=\"declassify\"]\n...", metadata: { layer: "quarantine-notice", clearable: "declassify", scope: "session-memory" } },
    ]);
    const notice = body.querySelector(".kernel-block-notice")!;
    expect(notice).not.toBeNull();
    expect(notice.querySelector("button")!.textContent).toContain("Declassify & retry");
  });
});

// The reload path: what the server persists is what the row can rebuild from.
describe("a reloaded chat rebuilds the notice from the persisted row", () => {
  const user = (content: string) => ({ role: "user", content }) as never;
  const asstCall = (id: string, name: string, args: Record<string, unknown>) =>
    ({ role: "assistant", content: "", tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] }) as never;
  const sess = (messages: unknown[]): Session => ({ id: "s", title: "t", createdAt: 0, updatedAt: 0, messages: messages as Session["messages"] });
  const toolsOf = (s: Session) => (projectSessionForUI(s).messages[1] as { _tools: ToolEvent[] })._tools;

  it("from the incident's own stored row — header only, no record — the notice and its button come back", () => {
    // Verbatim shape of the 2026-09-27 row in ~/.lax/sessions/chat-mukgvypc-r1tbc.jsonl.
    const stored = "[blocked, layer=\"arikernel\", clearable=\"declassify\"]\nUser hint: The security kernel blocked this tool call.\nRecovery: ...\nBLOCKED by ARI kernel: [ARI kernel] evaluation error, blocked in ariRequired mode: Tool call denied: Action 'http.post' denied: behavioral rule triggered by egress attempt. Run has been quarantined.";
    const tools = toolsOf(sess([
      user("Key saved"),
      asstCall("toolu_016B", "http_request", { url: "https://api.supabase.com/v1/projects/x/database/query", method: "POST" }),
      { role: "tool", tool_call_id: "toolu_016B", content: stored } as never,
    ]));
    expect(tools.find((t) => t.type === "end")?.metadata).toEqual({ layer: "arikernel", clearable: "declassify" });
    const body = render(tools);
    const notice = body.querySelector(".kernel-block-notice")!;
    expect(notice).not.toBeNull();
    expect(notice.closest(".activity-group")).toBeNull();
    expect(notice.querySelector("button")!.textContent).toContain("Declassify & retry");
  });

  it("from a row carrying the block record, the rule and scope come back too", () => {
    const tools = toolsOf(sess([
      user("continue"),
      asstCall("t1", "bash", { command: "echo ok" }),
      {
        role: "tool", tool_call_id: "t1", content: "[blocked, layer=\"arikernel\", rule=\"secret_access_then_any_egress\", trigger=\"restricted\", scope=\"operation\"]\n...",
        _block: { layer: "arikernel", reason: "BLOCKED by ARI kernel: ...", scope: "operation", notice: "kernel-notice", quarantine: { trigger: "restricted", rule: "secret_access_then_any_egress", reason: "r", restrictedAt: "2026-09-28T02:51:15.277Z", deniedActions: 3 } },
      } as never,
    ]));
    const end = tools.find((t) => t.type === "end")!;
    expect(end.status).toBe("blocked");
    expect((end.metadata as { quarantine: { rule: string } }).quarantine.rule).toBe("secret_access_then_any_egress");
    const body = render(tools);
    const notice = body.querySelector(".kernel-block-notice")!;
    expect(notice.getAttribute("data-rule")).toBe("secret_access_then_any_egress");
    expect(notice.querySelector("button")).toBeNull();
  });
});
