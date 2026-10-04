// @vitest-environment happy-dom
//
// The agent never types into a password field: whatever it types passes
// through the model provider. Every in-app fill path refuses one (the
// Playwright paths are held to it in actions.test.ts); a password reaches a
// page only from the vault (browser_fill_from_secret) or the user's hands.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./bridge-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bridge-client.js")>()),
  browserExec: vi.fn(),
  browserInput: vi.fn(),
  browserLifecycle: vi.fn(),
}));
vi.mock("./stability.js", () => ({ waitForStability: vi.fn().mockResolvedValue(undefined) }));

import { browserExec, browserInput, browserLifecycle } from "./bridge-client.js";
import { fillRefInApp, type InAppActionContext, type ResolvedTarget } from "./in-app-actions.js";
import { fillSelectorInApp } from "./in-app-selector-actions.js";
import { fillScript } from "./in-app-scripts.js";
import { stableFillScript } from "./in-app-fill-scripts.js";
import { PASSWORD_FIELD_REFUSAL } from "./password-field-rule.js";
import type { DurableRef, ObservationRegistry } from "./observation.js";
import type { Page } from "playwright";

// The DOM happy-dom provides; this project compiles without the DOM lib.
const page = (globalThis as unknown as {
  document: { body: { innerHTML: string }; getElementById(id: string): { value: string } | null };
}).document;
const valueOf = (id: string): string | undefined => page.getElementById(id)?.value;

function ref(over: Partial<DurableRef> = {}): DurableRef {
  return {
    id: 4, signature: "sig", role: "textbox", name: "Password", tag: "INPUT", type: "",
    xpath: "/input[1]", inViewport: true, lastSeen: 1, rect: { x: 10, y: 10, width: 80, height: 20 }, ...over,
  };
}

function ctx(r: DurableRef): InAppActionContext {
  const registry = {
    get: (id: number) => (id === r.id ? r : undefined),
    recoverStaleRef: (id: number) => (id === r.id ? r : undefined),
    observe: vi.fn(),
  } as unknown as ObservationRegistry;
  return { viewId: "view-pw", page: { url: () => "https://x/" } as unknown as Page, registry, retryDelayMs: 0, settleMs: 0 };
}

function hit(over: Partial<ResolvedTarget> = {}): ResolvedTarget {
  return { found: true, via: "role", x: 20, y: 20, w: 80, h: 20, dpr: 1, zoom: 1, tag: "INPUT", type: "", editable: false, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(browserInput).mockResolvedValue(undefined);
  vi.mocked(browserLifecycle).mockResolvedValue({ ping: { ok: true, userActive: false } });
  page.body.innerHTML = "";
});

describe("the in-app ref fill", () => {
  it("refuses a field the snapshot recorded as a password field, before reaching the page", async () => {
    const res = await fillRefInApp(ctx(ref({ type: "password" })), 4, "hunter2");
    expect(res).toEqual({ ok: false, text: `[4] ${PASSWORD_FIELD_REFUSAL}` });
    expect(browserExec).not.toHaveBeenCalled();
    expect(browserInput).not.toHaveBeenCalled();
  });

  it("refuses when the element at the point is a password field: no click, no keystroke", async () => {
    vi.mocked(browserExec).mockResolvedValue(hit({ type: "password" }));
    const res = await fillRefInApp(ctx(ref()), 4, "hunter2");
    expect(res.ok).toBe(false);
    expect(res.text).toContain(PASSWORD_FIELD_REFUSAL);
    expect(browserInput).not.toHaveBeenCalled();
  });
});

describe("the in-app fill scripts, run against a real password input", () => {
  it("the selector fill leaves it empty and says why", () => {
    page.body.innerHTML = '<input id="pw" type="password">';
    expect(eval(fillScript("#pw", "hunter2"))).toEqual({ ok: false, error: "password-field" });
    expect(valueOf("pw")).toBe("");
  });

  it("the stable-id fill leaves it empty and says why", () => {
    page.body.innerHTML = '<input id="pw" type="password">';
    expect(eval(stableFillScript(ref({ ids: { id: "pw" } }), "hunter2"))).toEqual({ ok: false, error: "password-field" });
    expect(valueOf("pw")).toBe("");
  });

  it("an ordinary field still fills", () => {
    page.body.innerHTML = '<input id="email" type="email">';
    expect(eval(fillScript("#email", "pat@home.example"))).toMatchObject({ ok: true });
  });

  it("the selector fill turns the script's refusal into the rule's message", async () => {
    vi.mocked(browserExec).mockResolvedValue({ ok: false, error: "password-field" });
    await expect(fillSelectorInApp("view-pw", "#pw", "hunter2")).rejects.toThrow(PASSWORD_FIELD_REFUSAL);
  });
});

describe("the refusal the agent reads", () => {
  it("points to the vault or the user, and keeps the rest of the request going", () => {
    expect(PASSWORD_FIELD_REFUSAL).toContain("browser_fill_from_secret");
    expect(PASSWORD_FIELD_REFUSAL).toContain("request_secret");
    expect(PASSWORD_FIELD_REFUSAL).toMatch(/Continue with any other part of the request/);
    expect(PASSWORD_FIELD_REFUSAL).not.toMatch(/(^|\s)STOP\.(\s|$)/);
  });
});
