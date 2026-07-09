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

describe("visionVerdictForScreenshot — mandated design spec", () => {
  it("injects the exact spec + token-adherence instruction into the judge prompt", async () => {
    let seen = "";
    const dispatch = vi.fn(async (opts: DispatchOptions) => { seen = opts.prompt; return '{"ok":true,"reason":"ok","design":{"score":2,"issues":["accent is red, spec mandates #2563eb"]}}'; });
    const spec = "Palette (exact): --accent #2563eb · font: Inter";
    const v = await visionVerdictForScreenshot(PNG, "a todo app", { dispatch }, spec);
    expect(seen).toContain("MANDATED DESIGN SYSTEM");
    expect(seen).toContain("--accent #2563eb");
    expect(seen).toContain("Weight adherence to this spec HEAVILY");
    expect(v?.design?.score).toBe(2);
  });

  it("omits the mandated-spec section when no spec is given (generic scoring)", async () => {
    let seen = "";
    const dispatch = vi.fn(async (opts: DispatchOptions) => { seen = opts.prompt; return '{"ok":true,"reason":"ok"}'; });
    await visionVerdictForScreenshot(PNG, "a todo app", { dispatch });
    expect(seen).not.toContain("MANDATED DESIGN SYSTEM");
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
    expect(opts.prompt).toContain('{"ok": boolean, "reason": string, "design": {"score": integer, "issues": [string]}}');
    // Both jobs ride the SAME single dispatch — the prompt asks for the design rubric too.
    expect(opts.prompt).toContain("Design assessment");
  });

  it("carries multiple screenshots in ONE dispatch and frames them as before/after the primary action", async () => {
    const spy = dispatchReturning('{"ok": true, "reason": "fine"}');
    await visionVerdictForScreenshot([PNG, PNG + "2"], "a maze game", { dispatch: spy });
    const opts = spy.mock.calls[0][0];
    expect(opts.images).toEqual([PNG, PNG + "2"]);
    expect(opts.prompt).toContain("AFTER clicking its primary action");
    expect(opts.prompt).toContain("a maze game");
  });

  it("an array of only blank screenshots degrades to null without dispatching", async () => {
    const spy = dispatchReturning('{"ok": true, "reason": "fine"}');
    const verdict = await visionVerdictForScreenshot(["  ", ""], "a maze game", { dispatch: spy });
    expect(verdict).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("visionVerdictForScreenshot — graded design rubric", () => {
  it("carries a well-formed design block alongside the broken-check", async () => {
    const verdict = await visionVerdictForScreenshot(PNG, "a todo app", {
      dispatch: dispatchReturning(
        '{"ok": true, "reason": "Styled todo list", "design": {"score": 4, "issues": ["low contrast on secondary text", "cramped spacing in header"]}}',
      ),
    });
    expect(verdict).toEqual({
      ok: true,
      reason: "Styled todo list",
      design: { score: 4, issues: ["low contrast on secondary text", "cramped spacing in header"] },
    });
  });

  it("stays valid with design undefined for the old {ok,reason} shape", async () => {
    const verdict = await visionVerdictForScreenshot(PNG, "a todo app", {
      dispatch: dispatchReturning('{"ok": false, "reason": "Blank page"}'),
    });
    expect(verdict).toEqual({ ok: false, reason: "Blank page" });
    expect(verdict?.design).toBeUndefined();
  });

  it("ignores a non-object design block but preserves a valid ok", async () => {
    const verdict = await visionVerdictForScreenshot(PNG, "a todo app", {
      dispatch: dispatchReturning('{"ok": true, "reason": "fine", "design": "bad"}'),
    });
    expect(verdict?.ok).toBe(true);
    expect(verdict?.reason).toBe("fine");
    expect(verdict?.design).toBeUndefined();
  });

  it("drops the design block when score is not a number, keeping ok", async () => {
    const verdict = await visionVerdictForScreenshot(PNG, "a todo app", {
      dispatch: dispatchReturning('{"ok": true, "reason": "fine", "design": {"score": "high", "issues": ["x"]}}'),
    });
    expect(verdict?.ok).toBe(true);
    expect(verdict?.design).toBeUndefined();
  });

  it("clamps an above-range design score to 5", async () => {
    const verdict = await visionVerdictForScreenshot(PNG, "a todo app", {
      dispatch: dispatchReturning('{"ok": true, "reason": "fine", "design": {"score": 9, "issues": []}}'),
    });
    expect(verdict?.design?.score).toBe(5);
  });

  it("rounds and floors a fractional/negative design score into 0-5", async () => {
    const verdict = await visionVerdictForScreenshot(PNG, "a todo app", {
      dispatch: dispatchReturning('{"ok": true, "reason": "fine", "design": {"score": -3.7, "issues": []}}'),
    });
    expect(verdict?.design?.score).toBe(0);
  });

  it("coerces a non-array design.issues to an empty list", async () => {
    const verdict = await visionVerdictForScreenshot(PNG, "a todo app", {
      dispatch: dispatchReturning('{"ok": true, "reason": "fine", "design": {"score": 3, "issues": "oops"}}'),
    });
    expect(verdict?.design).toEqual({ score: 3, issues: [] });
  });

  it("keeps only string entries in design.issues", async () => {
    const verdict = await visionVerdictForScreenshot(PNG, "a todo app", {
      dispatch: dispatchReturning(
        '{"ok": true, "reason": "fine", "design": {"score": 2, "issues": ["low contrast", 5, null, "cramped spacing"]}}',
      ),
    });
    expect(verdict?.design).toEqual({ score: 2, issues: ["low contrast", "cramped spacing"] });
  });

  it("still nulls the whole verdict when ok is invalid, even with a good design block", async () => {
    const verdict = await visionVerdictForScreenshot(PNG, "a todo app", {
      dispatch: dispatchReturning('{"reason": "no ok", "design": {"score": 5, "issues": []}}'),
    });
    expect(verdict).toBeNull();
  });
});
