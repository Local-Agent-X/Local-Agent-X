// Shell calls that only printed their own words leave the model's view of
// finished turns (noop-shell-calls.ts; Grok's chat, 2026-11-27).
import { describe, expect, it } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { dropNoopShellCalls } from "./noop-shell-calls.js";
import { applyCheckpoint } from "./checkpoint-history.js";
import { markHarnessRow } from "../harness-rows.js";

type Row = ChatCompletionMessageParam;
const user = (content: string): Row => ({ role: "user", content });
const call = (id: string, name: string, args: object) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const said = (content: string, ...calls: ReturnType<typeof call>[]): Row => ({ role: "assistant", content, ...(calls.length ? { tool_calls: calls } : {}) }) as Row;
const result = (id: string, content: string): Row => ({ role: "tool", tool_call_id: id, content }) as Row;

describe("print-only shell calls in finished turns", () => {
  it("leave the view with their results and words; real calls and their words stay", () => {
    const history: Row[] = [
      user("build the shop helper"),
      said("Reading the spec.", call("a", "bash", { command: "unzip -l spec.zip" })), result("a", "spec/product.md"),
      said("Calling the greenfield entrypoint now.", call("b", "bash", { command: 'echo "calling start_app_build"' })), result("b", "[ok] calling start_app_build"),
      markHarnessRow(user("You've produced essentially the same response 3 times in a row."), "nudge" as never),
      said("Starting greenfield.", call("c", "bash", { command: "echo start" })), result("c", "[ok] start"),
      said("Writing it.", call("d", "write", { path: "spec/plan.md" }), call("e", "bash", { command: "echo done" })), result("d", "Wrote"), result("e", "[ok] done"),
      user("r u ok"),
    ];
    const view = dropNoopShellCalls(history);
    const text = JSON.stringify(view);
    expect(text).not.toContain("start_app_build");
    expect(text).not.toContain("echo");
    expect(text).not.toContain("Calling the greenfield entrypoint");
    expect(text).toContain("unzip -l spec.zip");
    // A row that also made a real call keeps its words and that call.
    const writing = view.find((m) => m.role === "assistant" && m.content === "Writing it.") as { tool_calls: unknown[] };
    expect(writing.tool_calls).toHaveLength(1);
    // Every remaining result still answers a call in the view.
    const ids = new Set(view.flatMap((m) => ((m as { tool_calls?: { id: string }[] }).tool_calls ?? []).map((c) => c.id)));
    for (const m of view) if (m.role === "tool") expect(ids.has((m as { tool_call_id: string }).tool_call_id)).toBe(true);
  });

  it("the turn still going keeps them: the model needs the refusal to correct itself", () => {
    const history: Row[] = [
      user("decide the chunk"),
      said("Overruling.", call("x", "bash", { command: 'echo "build_decide is the tool"' })), result("x", "Not run: ... `build_decide` is a tool: call it by name."),
    ];
    expect(dropNoopShellCalls(history)).toBe(history);
  });

  it("commands that do something are never touched, and an unchanged view is the same array", () => {
    const history: Row[] = [
      user("go"),
      said("Checking.", call("p", "bash", { command: "echo $PATH" }), call("q", "bash", { command: "npm test" })), result("p", "/usr/bin"), result("q", "ok"),
      user("next"),
    ];
    expect(dropNoopShellCalls(history)).toBe(history);
  });

  it("applies to the history the model is sent", () => {
    const history: Row[] = [
      user("build it"),
      said("Calling it now.", call("b", "bash", { command: "echo calling" })), result("b", "[ok] calling"),
      user("again"),
    ];
    expect(applyCheckpoint(history, undefined).map((m) => m.role)).toEqual(["user", "user"]);
  });
});
