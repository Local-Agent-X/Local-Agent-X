// The desktop's chat events against the phone's half of the contract (vendor/chat.ts).
// The desktop's ServerEvent union is wider (the web UI renders more), but every variant
// under a type the phone reads must fit the shared shape, or an installed phone drops
// or misreads it. These are compile-time checks: `npm run build` typechecks this file,
// so a ServerEvent change that breaks the phone fails the build.

import { describe, expect, it } from "vitest";
import type { ServerEvent } from "../types/server-events.js";
import type { ToolResultStatus } from "../types.js";
import type { ChatServerEvent, ToolResultStatus as SharedToolResultStatus } from "./vendor/protocol.js";
import { parseChatFrame } from "./vendor/protocol.js";

type PhoneReads = ChatServerEvent["type"];
type Emitted<T> = Extract<ServerEvent, { type: T }>;
/** true when the desktop emits `T` and every variant it emits fits the phone's shape. */
type Fits<T extends PhoneReads> = [Emitted<T>] extends [never]
  ? false
  : [Emitted<T>] extends [Extract<ChatServerEvent, { type: T }>]
    ? true
    : false;

const fits: { [T in PhoneReads]: Fits<T> } = {
  stream: true,
  reasoning: true,
  tool_start: true,
  tool_progress: true,
  tool_end: true,
  done: true,
  stopped: true,
  error: true,
  approval_requested: true,
  approval_resolved: true,
  approval_timeout: true,
  inject_queued: true,
  inject_consumed: true,
};

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const statusesMatch: Same<ToolResultStatus, SharedToolResultStatus> = true;

describe("chat contract with the phone", () => {
  it("every event type the phone reads is emitted in a shape it accepts", () => {
    expect(Object.values(fits).every(Boolean)).toBe(true);
    expect(statusesMatch).toBe(true);
  });

  it("a desktop event with desktop-only fields still parses on the phone", () => {
    const event: ServerEvent = { type: "tool_end", toolName: "read", result: "ok", allowed: true, status: "declined", metadata: { layer: "x" }, opId: "op" };
    expect(parseChatFrame({ type: "event", sessionId: "s", event }, "s")?.event).toEqual({
      type: "tool_end",
      toolName: "read",
      result: "ok",
      allowed: true,
      status: "declined",
    });
  });
});
