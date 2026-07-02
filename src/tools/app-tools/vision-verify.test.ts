import { describe, it, expect, vi } from "vitest";
import type { DispatchOptions } from "../../llm-dispatch.js";
import { visionVerdictForScreenshot } from "./vision-verify.js";

const PNG = "iVBORw0KGgoFAKE=";

function dispatchReturning(reply: string | null) {
  return vi.fn(async (_opts: DispatchOptions) => reply);
}

describe("visionVerdictForScreenshot — verdict parsing", () => {
  it("parses clean strict JSON", async () => {
    const verdict = await visionVerdictForScreenshot(PNG, "a todo app", {
      dispatch: dispatchReturning('{"ok": true, "reason": "Styled todo list with items"}'),
    });
    expect(verdict).toEqual({ ok: true, reason: "Styled todo list with items" });
  });

  it("parses JSON wrapped in code fences", async () => {
    const verdict = await visionVerdictForScreenshot(PNG, "a todo app", {
      dispatch: dispatchReturning('```json\n{"ok": false, "reason": "Blank white page"}\n```'),
    });
    expect(verdict).toEqual({ ok: false, reason: "Blank white page" });
  });

  it("extracts the first JSON object out of surrounding prose", async () => {
    const verdict = await visionVerdictForScreenshot(PNG, "a todo app", {
      dispatch: dispatchReturning('Here is my verdict: {"ok": true, "reason": "Looks fine"} — done.'),
    });
    expect(verdict).toEqual({ ok: true, reason: "Looks fine" });
  });

  it("survives braces inside the reason string", async () => {
    const verdict = await visionVerdictForScreenshot(PNG, "a todo app", {
      dispatch: dispatchReturning('{"ok": false, "reason": "Error overlay shows {code: 500}"}'),
    });
    expect(verdict).toEqual({ ok: false, reason: "Error overlay shows {code: 500}" });
  });

  it("returns null for garbage output", async () => {
    const verdict = await visionVerdictForScreenshot(PNG, "a todo app", {
      dispatch: dispatchReturning("I cannot see any image here, sorry!"),
    });
    expect(verdict).toBeNull();
  });

  it("returns null when ok is missing or not a boolean", async () => {
    expect(
      await visionVerdictForScreenshot(PNG, "a todo app", {
        dispatch: dispatchReturning('{"reason": "no ok field"}'),
      }),
    ).toBeNull();
    expect(
      await visionVerdictForScreenshot(PNG, "a todo app", {
        dispatch: dispatchReturning('{"ok": "yes", "reason": "stringly typed"}'),
      }),
    ).toBeNull();
  });

  it("takes the parsed JSON at face value for uncertain phrasing — no local overrides", async () => {
    // The prompt asks the MODEL to default uncertain cases to ok:true; the
    // parser must not second-guess an explicit ok:false just because the
    // reason sounds hedged.
    const verdict = await visionVerdictForScreenshot(PNG, "a todo app", {
      dispatch: dispatchReturning('{"ok": false, "reason": "Hard to tell, might be mid-load, but appears blank"}'),
    });
    expect(verdict).toEqual({ ok: false, reason: "Hard to tell, might be mid-load, but appears blank" });
  });
});

describe("visionVerdictForScreenshot — degradation", () => {
  it("returns null when dispatch returns null (no provider/credential)", async () => {
    const verdict = await visionVerdictForScreenshot(PNG, "a todo app", {
      dispatch: dispatchReturning(null),
    });
    expect(verdict).toBeNull();
  });

  it("returns null instead of throwing when dispatch throws", async () => {
    const verdict = await visionVerdictForScreenshot(PNG, "a todo app", {
      dispatch: vi.fn(async () => { throw new Error("network down"); }),
    });
    expect(verdict).toBeNull();
  });

  it("returns null without dispatching when the screenshot is empty", async () => {
    const spy = dispatchReturning('{"ok": true, "reason": "unreachable"}');
    const verdict = await visionVerdictForScreenshot("   ", "a todo app", { dispatch: spy });
    expect(verdict).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns null instead of throwing when the screenshot is not a string", async () => {
    // The probe's screenshot is optional across the IPC boundary; TS types say
    // string but undefined is a real runtime input the never-throw contract owns.
    const spy = dispatchReturning('{"ok": true, "reason": "unreachable"}');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const verdict = await visionVerdictForScreenshot(undefined as any, "a todo app", { dispatch: spy });
    expect(verdict).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns null instead of throwing when dispatch resolves a non-string", async () => {
    const verdict = await visionVerdictForScreenshot(PNG, "a todo app", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dispatch: vi.fn(async () => 42 as any),
    });
    expect(verdict).toBeNull();
  });
});

describe("visionVerdictForScreenshot — dispatch request mapping", () => {
  it("pins Anthropic, attaches the screenshot as an image, and bounds output", async () => {
    const spy = dispatchReturning('{"ok": true, "reason": "fine"}');
    await visionVerdictForScreenshot(PNG, "a weather dashboard", { dispatch: spy });
    expect(spy).toHaveBeenCalledTimes(1);
    const opts = spy.mock.calls[0][0];
    expect(opts.provider).toBe("anthropic");
    expect(opts.images).toEqual([PNG]);
    expect(opts.maxTokens).toBe(200);
    expect(opts.temperature).toBe(0);
    expect(opts.prompt).toContain("a weather dashboard");
    expect(opts.prompt).toContain('{"ok": boolean, "reason": string}');
  });
});
