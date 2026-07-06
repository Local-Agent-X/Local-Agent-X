import { describe, it, expect, vi } from "vitest";
import { HookEngine, parseHookDirective } from "./hook-engine.js";
import type { HookDefinition, HookEventContext, HookResult } from "./hook-types.js";

describe("parseHookDirective — strict JSON control messages only", () => {
  it("accepts continue / reason / rewriteArgs", () => {
    expect(parseHookDirective('{"continue": false, "reason": "nope"}')).toEqual({ continue: false, reason: "nope" });
    expect(parseHookDirective('{"rewriteArgs": {"path": "b.txt"}}')).toEqual({ rewriteArgs: { path: "b.txt" } });
  });

  it("rejects ordinary output — prose, arrays, JSON without recognized keys, malformed JSON", () => {
    expect(parseHookDirective("All tests passed")).toBeNull();
    expect(parseHookDirective('["continue"]')).toBeNull();
    expect(parseHookDirective('{"status": "ok", "tests": 12}')).toBeNull();
    expect(parseHookDirective('{"continue": fal')).toBeNull();
    expect(parseHookDirective("")).toBeNull();
  });

  it("ignores a non-object rewriteArgs and non-boolean continue", () => {
    expect(parseHookDirective('{"rewriteArgs": [1,2]}')).toBeNull();
    expect(parseHookDirective('{"continue": "yes"}')).toBeNull();
  });
});

/** HookEngine with the hook RUNNER scripted per hook name — exercises fire()'s
 *  real ordering/blocking/chaining logic without spawning shells. */
class ScriptedEngine extends HookEngine {
  public seenArgs: Array<Record<string, unknown> | undefined> = [];
  constructor(defs: HookDefinition[], private script: Record<string, HookResult>) {
    super();
    (this as unknown as { hooks: HookDefinition[] }).hooks = defs;
  }
  protected override runHook(hook: HookDefinition, ctx: HookEventContext): Promise<HookResult> {
    this.seenArgs.push(ctx.toolArgs);
    return Promise.resolve(this.script[hook.name ?? ""] ?? { continue: true });
  }
}

const preHook = (name: string): HookDefinition => ({ event: "PreToolUse", name, type: "command", command: "x" });

describe("fire() — rewrite chaining", () => {
  it("chains rewrites: each hook sees the previous rewrite, the final one is returned", async () => {
    const engine = new ScriptedEngine([preHook("a"), preHook("b")], {
      a: { continue: true, rewriteArgs: { path: "one.txt" } },
      b: { continue: true, rewriteArgs: { path: "two.txt" } },
    });
    const r = await engine.fire({ event: "PreToolUse", toolName: "write", toolArgs: { path: "orig.txt" } });
    expect(r.continue).toBe(true);
    expect(r.rewriteArgs).toEqual({ path: "two.txt" });
    expect(engine.seenArgs).toEqual([{ path: "orig.txt" }, { path: "one.txt" }]);
  });

  it("a blocking hook stops the chain and returns no rewrite", async () => {
    const engine = new ScriptedEngine([preHook("a"), preHook("b")], {
      a: { continue: false, reason: "blocked by a" },
      b: { continue: true, rewriteArgs: { path: "never.txt" } },
    });
    const r = await engine.fire({ event: "PreToolUse", toolName: "write", toolArgs: { path: "orig.txt" } });
    expect(r.continue).toBe(false);
    expect(r.reason).toBe("blocked by a");
    expect(r.rewriteArgs).toBeUndefined();
    expect(engine.seenArgs).toHaveLength(1);
  });

  it("no rewrite → no rewriteArgs on the result", async () => {
    const engine = new ScriptedEngine([preHook("a")], { a: { continue: true } });
    const r = await engine.fire({ event: "PreToolUse", toolName: "write", toolArgs: { path: "orig.txt" } });
    expect(r).toEqual({ continue: true });
  });

  it("a rewrite on a non-PreToolUse event is ignored", async () => {
    const engine = new ScriptedEngine([{ event: "Stop", name: "s", type: "command", command: "x" }], {
      s: { continue: true, rewriteArgs: { sneak: true } },
    });
    const r = await engine.fire({ event: "Stop", opId: "op-1", opStatus: "succeeded" });
    expect(r.rewriteArgs).toBeUndefined();
  });

  it("Stop hooks match without a tool name (toolFilter hooks stay quiet elsewhere)", async () => {
    const run = vi.fn();
    class CountingEngine extends ScriptedEngine {
      protected override runHook(hook: HookDefinition, ctx: HookEventContext): Promise<HookResult> {
        run(hook.name, ctx.event);
        return super.runHook(hook, ctx);
      }
    }
    const engine = new CountingEngine([{ event: "Stop", name: "s", type: "command", command: "x" }], { s: { continue: true } });
    await engine.fire({ event: "Stop", opId: "op-1", opStatus: "failed" });
    expect(run).toHaveBeenCalledWith("s", "Stop");
  });
});
