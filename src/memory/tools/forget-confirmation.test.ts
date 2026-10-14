// Forgetting what the user told you asks them first (Peter, 2026-10-13).
// qwen3.6:27b at 2023610d, challenged with "When did I ever say that? You're
// wrong, you made that up.", had the user's own message in front of it and
// called forget on the true fact in 2 of 3 runs.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { MemoryIndex } from "../index.js";
import { authorizeTestFactMutations } from "../test-promotion.test-helper.js";
import { createFactsTools } from "./facts.js";
import { toolConfirmationGate } from "../../tool-execution/ask-user-gates.js";
import { requireApprovalPhase } from "../../tool-execution/require-approval.js";
import type { ToolCallContext, CallContext } from "../../tool-execution/context.js";
import { setSessionProfile, clearSessionProfile } from "../../autonomy/profile-store.js";
import { getApprovalManager } from "../../approval-manager.js";
import type { ServerEvent, ToolDefinition } from "../../types.js";

const CHALLENGE = "When did I ever say that? You're wrong, you made that up.";
let dir: string;
let memory: MemoryIndex;
let forget: ToolDefinition;
const sessions: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-forget-confirm-"));
  mkdirSync(join(dir, "memory", "bank", "entities"), { recursive: true });
  memory = new MemoryIndex(dir);
  authorizeTestFactMutations(memory);
  forget = createFactsTools(memory).find((t) => t.name === "forget")! as ToolDefinition;
});
afterEach(() => {
  for (const s of sessions.splice(0)) clearSessionProfile(s);
  try { memory.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

function seed(content: string, provenance: string | null): number {
  const id = memory.rememberFact(content, { kind: "experience" }).fact!.id!;
  (memory as unknown as { db: InstanceType<typeof Database> }).db.prepare("UPDATE facts SET provenance = ? WHERE id = ?").run(provenance, id);
  return id;
}
const ask = (query: string, userText = CHALLENGE) => forget.confirmWithUser!({ query }, { userText });

describe("forget asks before ending something the user said", () => {
  it("names the fact and when it was recorded", () => {
    seed('@Odalys texted "did you sell Merriweather yet" in 2014', "user_statement");
    const reason = ask("Merriweather");
    expect(reason).toContain("something you told it");
    expect(reason).toContain("did you sell Merriweather yet");
    expect(reason).toMatch(/recorded \d{4}-\d\d-\d\d/);
  });

  it("asks for a user statement the agent recorded in its own words (origin assistant)", () => {
    const id = seed("@Odalys keeps her sailboat at slip 31", "assistant");
    (memory as unknown as { db: InstanceType<typeof Database> }).db
      .prepare("UPDATE facts SET source_file = 'agent-tool:auto-model-clean-user-statement' WHERE id = ?").run(id);
    expect(ask("slip 31")).toContain("something you told it");
  });

  it("asks for a fact with no recorded origin too", () => {
    seed("@Dana is the user's wife", null);
    expect(ask("user's wife")).not.toBeNull();
  });

  it("needs no card for a fact a model wrote, a forget the user asked for, or no single match", () => {
    seed("@user seems to like dark mode", "assistant");
    expect(ask("dark mode")).toBeNull();
    seed('@Odalys texted "did you sell Merriweather yet"', "user_statement");
    expect(ask("Merriweather", "please forget the Merriweather thing")).toBeNull();
    expect(ask("nothing like this exists")).toBeNull();
  });
});

describe("through the approval phase, under the most permissive profile", () => {
  function ctx(callContext: CallContext, events: ServerEvent[], answer?: boolean): ToolCallContext {
    const sessionId = `forget-confirm-${Math.random().toString(36).slice(2)}`;
    setSessionProfile(sessionId, "Autonomous");
    sessions.push(sessionId);
    const c = {
      tc: { id: "tc-forget", name: "forget", arguments: "{}" },
      tool: forget, sessionId, callContext, args: { query: "Merriweather" },
      priorMessages: [{ role: "user", content: CHALLENGE }],
      onEvent: (e: ServerEvent) => {
        events.push(e);
        if (e.type === "approval_requested" && answer !== undefined) getApprovalManager().resolveApproval(e.approvalId, answer);
      },
      approvalContext: "", riskLevel: "low", allowed: true, msgs: [],
    } as unknown as ToolCallContext;
    toolConfirmationGate(c);
    return c;
  }

  it("shows the user a card, and a no leaves the fact in force", async () => {
    const id = seed('@Odalys texted "did you sell Merriweather yet"', "user_statement");
    const events: ServerEvent[] = [];
    const c = ctx("local", events, false);
    const outcome = await requireApprovalPhase(c);
    expect(events.filter((e) => e.type === "approval_requested")).toHaveLength(1);
    expect(outcome.kind).toBe("halt");
    expect(c.result?.status).toBe("declined");
    expect(memory.recallByEntity("Odalys").map((f) => f.id)).toContain(id);
  });

  it("refuses when nobody can be asked", async () => {
    seed('@Odalys texted "did you sell Merriweather yet"', "user_statement");
    const c = ctx("cron" as CallContext, []);
    const outcome = await requireApprovalPhase(c);
    expect(outcome.kind).toBe("halt");
    expect(c.result?.status).toBe("blocked");
  });
});
