import { describe, it, expect } from "vitest";
import { detectCommittingCalls, turnPerformedCommittingCall, isCommittingTool } from "../src/committing-tool-check.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";

const asst = (toolCalls: Array<{ name: string; args?: Record<string, unknown> }>): ChatCompletionMessageParam =>
  ({
    role: "assistant",
    content: null,
    tool_calls: toolCalls.map((tc, i) => ({
      id: `tc-${i}`,
      type: "function",
      function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) },
    })),
  } as unknown as ChatCompletionMessageParam);

describe("isCommittingTool", () => {
  it("returns true for email_send", () => {
    expect(isCommittingTool("email_send")).toBe(true);
  });

  it("returns true for write/edit/bash (non-idempotent file ops)", () => {
    expect(isCommittingTool("write")).toBe(true);
    expect(isCommittingTool("edit")).toBe(true);
    expect(isCommittingTool("bash")).toBe(true);
  });

  it("returns false for read tools", () => {
    expect(isCommittingTool("read")).toBe(false);
    expect(isCommittingTool("grep")).toBe(false);
    expect(isCommittingTool("glob")).toBe(false);
  });

  it("returns false for unknown tool names", () => {
    expect(isCommittingTool("totally_made_up")).toBe(false);
  });
});

describe("detectCommittingCalls", () => {
  it("returns empty when no committing calls were made", () => {
    const messages: ChatCompletionMessageParam[] = [asst([{ name: "read", args: { path: "x.ts" } }])];
    expect(detectCommittingCalls(messages)).toEqual([]);
  });

  it("flags an email_send call", () => {
    const messages: ChatCompletionMessageParam[] = [asst([{ name: "email_send", args: { to: "a@b.c" } }])];
    const r = detectCommittingCalls(messages);
    expect(r).toHaveLength(1);
    expect(r[0].toolName).toBe("email_send");
  });

  it("does NOT flag http_request with GET method", () => {
    const messages: ChatCompletionMessageParam[] = [
      asst([{ name: "http_request", args: { method: "GET", url: "https://example.com" } }]),
    ];
    expect(detectCommittingCalls(messages)).toEqual([]);
  });

  it("flags http_request with POST", () => {
    const messages: ChatCompletionMessageParam[] = [
      asst([{ name: "http_request", args: { method: "POST", url: "https://api.example.com/charge" } }]),
    ];
    const r = detectCommittingCalls(messages);
    expect(r).toHaveLength(1);
    expect(r[0].toolName).toBe("http_request");
    expect(r[0].reason).toContain("POST");
  });

  it("flags http_request with DELETE/PUT/PATCH", () => {
    for (const method of ["DELETE", "PUT", "PATCH"]) {
      const messages: ChatCompletionMessageParam[] = [
        asst([{ name: "http_request", args: { method, url: "https://api.example.com/x" } }]),
      ];
      expect(detectCommittingCalls(messages)).toHaveLength(1);
    }
  });

  it("treats http_request with unparseable args as committing (conservative)", () => {
    // Hand-craft a message with non-JSON arguments string
    const messages: ChatCompletionMessageParam[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "x", type: "function", function: { name: "http_request", arguments: "{not json" } },
        ],
      } as unknown as ChatCompletionMessageParam,
    ];
    const r = detectCommittingCalls(messages);
    expect(r).toHaveLength(1);
    expect(r[0].reason).toContain("unparseable");
  });

  it("flags browser click on a Send button", () => {
    const messages: ChatCompletionMessageParam[] = [
      asst([{ name: "browser", args: { action: "click", text: "Send Message" } }]),
    ];
    const r = detectCommittingCalls(messages);
    expect(r).toHaveLength(1);
    expect(r[0].reason).toMatch(/click/);
  });

  it("flags browser click on a Submit / Pay / Confirm / Delete / Publish button", () => {
    for (const label of ["Submit", "Pay Now", "Confirm Order", "Delete Account", "Publish Post"]) {
      const messages: ChatCompletionMessageParam[] = [
        asst([{ name: "browser", args: { action: "click_text", text: label } }]),
      ];
      expect(detectCommittingCalls(messages).length).toBeGreaterThan(0);
    }
  });

  it("does NOT flag browser click on a benign button", () => {
    const messages: ChatCompletionMessageParam[] = [
      asst([{ name: "browser", args: { action: "click", text: "Open Menu" } }]),
    ];
    expect(detectCommittingCalls(messages)).toEqual([]);
  });

  it("aggregates findings across multiple assistant turns in the same message list", () => {
    const messages: ChatCompletionMessageParam[] = [
      asst([{ name: "read", args: { path: "x" } }]),
      asst([{ name: "email_send", args: { to: "a@b.c" } }]),
      asst([{ name: "memory_save", args: { text: "..." } }]),
    ];
    const r = detectCommittingCalls(messages);
    expect(r.map(f => f.toolName).sort()).toEqual(["email_send", "memory_save"]);
  });

  it("ignores non-assistant roles", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "do email_send" } as ChatCompletionMessageParam,
      { role: "tool", content: "fake email_send result", tool_call_id: "x" } as ChatCompletionMessageParam,
    ];
    expect(detectCommittingCalls(messages)).toEqual([]);
  });
});

describe("turnPerformedCommittingCall", () => {
  it("returns true when at least one committing call exists", () => {
    const messages: ChatCompletionMessageParam[] = [asst([{ name: "write", args: { path: "x" } }])];
    expect(turnPerformedCommittingCall(messages)).toBe(true);
  });

  it("returns false on a read-only turn", () => {
    const messages: ChatCompletionMessageParam[] = [asst([{ name: "grep", args: { pattern: "x" } }])];
    expect(turnPerformedCommittingCall(messages)).toBe(false);
  });
});
