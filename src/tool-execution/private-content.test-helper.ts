// Shared fixtures for the private-content gate tests: a session with its own
// trusted-destinations dir, the email and document every test reads, and a
// call context built the way execute-tool builds it (the chat rides in
// priorMessages; ctx.msgs starts empty).
import { afterEach, beforeEach, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { createContext, type CallContext, type ToolCallContext } from "./context.js";
import type { SecurityLayer } from "../security/index.js";
import { privateContentGate, type PrivateGateDeps } from "./private-content-gate.js";
import { recordPrivateReadFromResult } from "./private-read-record.js";
import { clearPrivateContent } from "../data-lineage/private-content.js";

export const STATEMENT = "Statement for October: checking account ending 4471 closed at 18,240.17 after the mortgage draft and the payroll deposit from Brightline Logistics.";
export const EMAIL = `From: billing@firstcoastbank.example\nTo: pat@home.example\nSubject: Your October statement\n\n${STATEMENT}`;
export const RESUME = join(homedir(), "Documents", "lax-gate-test", "resume-2026.txt");
export const RESUME_TEXT = "Pat Rivera, 2214 Larkspur Lane, Tacoma WA 98404. Senior logistics analyst at Brightline Logistics since 2019, before that dispatch lead at Harbor Freightways.";

export const state = { dir: "", sid: "" };
let n = 0;
const prevDataDir = process.env.LAX_DATA_DIR;

/** Fresh session and trusted-destinations dir per test. */
export function useIsolatedSession(): void {
  beforeEach(() => {
    state.dir = mkdtempSync(join(tmpdir(), "lax-private-gate-"));
    process.env.LAX_DATA_DIR = state.dir;
    state.sid = `s-private-${process.pid}-${n++}`;
  });
  afterEach(() => {
    clearPrivateContent(state.sid);
    if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prevDataDir;
    rmSync(state.dir, { recursive: true, force: true });
  });
}

export function ctx(
  name: string,
  args: Record<string, unknown>,
  chat: string | ChatCompletionMessageParam[] = "summarize my latest bank email",
  callContext: CallContext = "local",
): ToolCallContext {
  const priorMessages: ChatCompletionMessageParam[] = typeof chat === "string" ? [{ role: "user", content: chat }] : chat;
  const c = createContext({
    tc: { id: `tc-${n++}`, name, arguments: JSON.stringify(args) },
    toolMap: new Map(),
    security: {} as SecurityLayer,
    sessionId: state.sid,
    callContext,
    priorMessages,
  });
  c.args = args;
  return c;
}

/** The card's text, or undefined when the gate has nothing to ask. */
export async function verdict(c: ToolCallContext, deps: PrivateGateDeps = {}): Promise<string | undefined> {
  const out = await privateContentGate(c, { browserCurrentUrl: async () => "", foregroundApp: async () => null, clipboardText: async () => "", ...deps });
  expect(out.kind).toBe("continue"); // never refuses on its own
  return c.policyApprovalReason;
}

export function readEmail(content = EMAIL, tool = "email_read_message"): void {
  recordPrivateReadFromResult(state.sid, tool, { uid: 7 }, { content }, 50_000);
}

export function readResume(): void {
  recordPrivateReadFromResult(state.sid, "read", { path: RESUME }, { content: RESUME_TEXT }, 50_000);
}
