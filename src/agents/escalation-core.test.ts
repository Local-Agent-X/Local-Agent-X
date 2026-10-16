// An agent escalating to the user must reach the user. Before the inbox, the
// only output was the `handler:agent-escalation` event, forwarded as an
// `agent-escalation` WS frame no client renders: the user never saw it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const comments: string[] = [];
vi.mock("../agent-store/index.js", () => ({
  AgentTemplateStore: { getInstance: () => ({ get: (id: string) => (id === "tpl-ada" ? { id, name: "Ada" } : undefined) }) },
  ProjectStore: { getInstance: () => ({ getAgentProject: () => undefined }) },
  IssueStore: {
    getInstance: () => ({
      get: (id: string) => (id === "iss-1" ? { id, projectId: "p1" } : null),
      comment: (_id: string, _by: string, text: string) => { comments.push(text); },
    }),
  },
}));
vi.mock("../project-rosters.js", () => ({ ProjectRosterStore: { getInstance: () => ({ listByAgent: () => [] }) } }));

const { performEscalation } = await import("./escalation-core.js");
const { inboxStore } = await import("../inbox/index.js");

let dir: string;
const prev = process.env.LAX_DATA_DIR;
beforeEach(() => { comments.length = 0; dir = mkdtempSync(join(tmpdir(), "lax-escalation-inbox-")); process.env.LAX_DATA_DIR = dir; });
afterEach(() => { if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev; rmSync(dir, { recursive: true, force: true }); });

describe("an escalation to the user", () => {
  it("creates a needs-you agent-message naming the agent, carrying the context, linked to the agent and issue", async () => {
    const outcome = await performEscalation({ callerAgentId: "tpl-ada", to: "user", context: "I need the staging API key to continue.", urgency: "high", issueId: "iss-1" });
    expect(outcome).toMatchObject({ ok: true, resolvedTarget: "user" });
    const items = inboxStore().list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "agent-message",
      title: "Ada needs you now",
      body: "I need the staging API key to continue.",
      needsYou: true,
      link: { agentId: "tpl-ada", issueId: "iss-1" },
    });
    expect(comments[0]).toContain("Escalated to user (high) by Ada");
  });

  it("a normal-urgency escalation is still a needs-you item", async () => {
    await performEscalation({ callerAgentId: "tpl-ada", to: "user", context: "Which region?", urgency: "normal" });
    expect(inboxStore().list()[0]).toMatchObject({ title: "Ada needs you", needsYou: true, link: { agentId: "tpl-ada" } });
  });

  it("a manager walk with no manager on the roster falls back to the user and reaches the inbox", async () => {
    await performEscalation({ callerAgentId: "tpl-ada", to: "manager", context: "blocked on review", urgency: "normal" });
    expect(inboxStore().list().map((i) => i.title)).toEqual(["Ada needs you"]);
  });

  it("a chat-origin escalation (no caller agent) is the chat talking to its own reader: no item", async () => {
    await performEscalation({ to: "user", context: "fyi", urgency: "normal" });
    expect(inboxStore().list()).toEqual([]);
  });
});
