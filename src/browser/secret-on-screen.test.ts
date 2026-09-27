// A secret the user can see never reaches the model through a screenshot; the
// agent is told how to save it without reading it. Live 2026-09-26: a new
// Supabase token was screenshotted out of its "Token created" dialog.
import { describe, it, expect, vi } from "vitest";
import type { SecretBrowserOps, VisibleValue } from "./secret-ops.js";
import { visibleValuesScript } from "./secret-ops.js";
import { findSecretOnScreen, secretOnScreenMessage } from "./secret-on-screen.js";
import { handleScreenshot } from "../tools/browser-tools/page.js";
import type { BrowserBackend } from "./index.js";

const FAKE_SUPABASE = "sbp_" + "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";
const RANDOM_TOKEN = "Zq8vN2kR7tLw4Xp9Hs3Jd6Fb1Mc5Gy0Ae8Uo2Ki7";
const COMMIT = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b";

const opsShowing = (values: VisibleValue[]): SecretBrowserOps => ({
  currentOrigin: async () => "https://supabase.com",
  describeElement: async () => ({ found: false, tag: "", type: "", autocomplete: "" }),
  readValue: async () => null,
  fillValue: async () => ({ kind: "not-found" }),
  pressEnter: async () => undefined,
  visibleValues: async () => values,
});

describe("findSecretOnScreen", () => {
  it("finds a known credential shape in a field and names it without its value", async () => {
    const hit = await findSecretOnScreen(opsShowing([
      { value: "primal-full-account", selector: "#token-name", field: true },
      { value: FAKE_SUPABASE, selector: "body > div:nth-of-type(3) > input:nth-of-type(1)", field: true },
    ]));
    expect(hit).toEqual({ kind: "Supabase Token", selector: "body > div:nth-of-type(3) > input:nth-of-type(1)", field: true });
  });

  it("a known shape counts in displayed text too", async () => {
    expect(await findSecretOnScreen(opsShowing([{ value: `Your token: ${FAKE_SUPABASE}`, selector: "#shown", field: false }])))
      .toMatchObject({ kind: "Supabase Token", field: false });
  });

  it("a random token counts only in a field — a code block of commit hashes does not block screenshots", async () => {
    expect(await findSecretOnScreen(opsShowing([{ value: RANDOM_TOKEN, selector: "#key", field: true }]))).not.toBeNull();
    expect(await findSecretOnScreen(opsShowing([{ value: `commit ${COMMIT}`, selector: "pre", field: false }]))).toBeNull();
    expect(await findSecretOnScreen(opsShowing([{ value: RANDOM_TOKEN, selector: "code", field: false }]))).toBeNull();
  });

  it("an ordinary page finds nothing", async () => {
    expect(await findSecretOnScreen(opsShowing([{ value: "Scan Progress", selector: "#org", field: true }]))).toBeNull();
    expect(await findSecretOnScreen(opsShowing([]))).toBeNull();
  });
});

describe("secretOnScreenMessage", () => {
  it("hands the agent the capture call, keeps the dialog open, and falls back to the user's secrets card", () => {
    const field = secretOnScreenMessage({ kind: "Supabase Token", selector: "#key", field: true });
    expect(field).toContain('browser_capture_to_secret({ name: "<SERVICE_PURPOSE_TOKEN>", service: "<service>", selector: "#key" })');
    expect(field).toMatch(/do not click Done/);
    expect(field).toMatch(/request_secrets/);
    expect(secretOnScreenMessage({ kind: "Supabase Token", selector: "pre", field: false })).toContain('text_selector: "pre"');
  });
});

describe("browser screenshot with a secret on screen", () => {
  const manager = (shot: () => Promise<unknown>) =>
    ({ getCurrentUrl: () => "https://supabase.com/dashboard/account/tokens", screenshot: shot }) as unknown as BrowserBackend;

  it("takes no screenshot and says why", async () => {
    const shot = vi.fn(async () => ({ text: "Screenshot captured", image: { mime: "image/png", b64: "x" } }));
    const result = await handleScreenshot(manager(shot), opsShowing([{ value: FAKE_SUPABASE, selector: "#key", field: true }]));
    expect(shot).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "blocked", isError: true, metadata: { browserStatus: "secret-on-screen" } });
    expect(String(result.content)).not.toContain(FAKE_SUPABASE);
  });

  it("an ordinary page is screenshotted as before", async () => {
    const shot = vi.fn(async () => ({ text: "Screenshot captured", image: { mime: "image/png", b64: "x" } }));
    const result = await handleScreenshot(manager(shot), opsShowing([]));
    expect(shot).toHaveBeenCalledOnce();
    expect(result.isError).toBeFalsy();
  });

  it("the page script is valid JavaScript", () => {
    expect(() => new Function(`return ${visibleValuesScript()}`)).not.toThrow();
  });
});
