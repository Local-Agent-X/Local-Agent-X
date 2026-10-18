// A scheduled job carries its image engine: the cron runner pins it to the
// run's session and resolveMediaProvider reads it through the call's session
// as the run's engine, ahead of the user's chat provider and the Settings →
// Media default. An explicit per-call backend still wins, and the paid-API
// switch judges every credential the same, pinned engine or not. Credentials
// and settings are mocked; nothing is fetched.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CredentialSource } from "../../auth/auth-provider.js";

const TOKEN = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_9" } })).toString("base64url")}.sig`;
const RUN = "cron-nightly-1700000000000";

let creds: Record<string, { credential: string; source: CredentialSource } | undefined> = {};
let settingsBag: Record<string, unknown> = {};

vi.mock("../../auth/resolve.js", () => ({
  resolveCredential: async (provider: string) => (creds[provider] ? { provider, ...creds[provider] } : null),
}));
vi.mock("../../settings.js", async (orig) => ({ ...(await orig<typeof import("../../settings.js")>()), loadSettings: () => settingsBag }));

const { resolveMediaProvider } = await import("./shared.js");
const { clearSessionImageEngine, sessionImageEngine, setSessionImageEngine } = await import("./image-engine.js");

const XAI_OAUTH = { credential: "xai-oauth", source: "oauth" } as const;
const XAI_KEY = { credential: "xai-key", source: "env" } as const;
const CHATGPT = { credential: TOKEN, source: "oauth" } as const;
const OPENAI_KEY = { credential: "sk-api", source: "secrets-store" } as const;

beforeEach(() => {
  creds = { xai: XAI_OAUTH, codex: CHATGPT, openai: OPENAI_KEY };
  settingsBag = { provider: "anthropic", imageEngine: "grok", allowPaidMediaApis: true };
});
afterEach(() => clearSessionImageEngine(RUN));

describe("a run's pinned image engine", () => {
  it("is the run's default, over the Settings → Media pick", async () => {
    setSessionImageEngine(RUN, "chatgpt");
    expect(await resolveMediaProvider(undefined, "image", RUN)).toEqual({ provider: "codex", apiKey: TOKEN, forced: false });
    expect(await resolveMediaProvider()).toEqual({ provider: "xai", apiKey: "xai-oauth", forced: false });
  });

  it("stands in for the user's chat provider, which is not what the run runs on", async () => {
    settingsBag = { ...settingsBag, provider: "xai" };
    setSessionImageEngine(RUN, "chatgpt");
    expect((await resolveMediaProvider(undefined, "image", RUN)).provider).toBe("codex");
    expect((await resolveMediaProvider(undefined, "image", "some-chat")).provider).toBe("xai");
  });

  it("yields to an explicit per-call backend", async () => {
    setSessionImageEngine(RUN, "chatgpt");
    expect(await resolveMediaProvider("grok", "image", RUN)).toEqual({ provider: "xai", apiKey: "xai-oauth", forced: true });
  });

  it("falls to the other engine, with a note, when the pinned one is not connected", async () => {
    creds = { xai: XAI_OAUTH };
    setSessionImageEngine(RUN, "chatgpt");
    expect(await resolveMediaProvider(undefined, "image", RUN)).toEqual({
      provider: "xai", apiKey: "xai-oauth", forced: false, note: "Made with Grok; ChatGPT isn't connected.",
    });
  });

  it("is gone once the run clears it", () => {
    setSessionImageEngine(RUN, "chatgpt");
    expect(sessionImageEngine(RUN)).toBe("chatgpt");
    clearSessionImageEngine(RUN);
    expect(sessionImageEngine(RUN)).toBeUndefined();
    expect(sessionImageEngine(undefined)).toBeUndefined();
  });
});

describe("the paid-API rule is the same for a run as for a chat", () => {
  beforeEach(() => { settingsBag = { provider: "anthropic", imageEngine: "chatgpt" }; });

  it("a pinned engine whose only credential is a paid key is no candidate while paid keys are off", async () => {
    creds = { xai: XAI_KEY, openai: OPENAI_KEY };
    setSessionImageEngine(RUN, "grok");
    expect(await resolveMediaProvider(undefined, "image", RUN)).toEqual({ provider: "anthropic", forced: false });
    settingsBag = { ...settingsBag, allowPaidMediaApis: true };
    expect(await resolveMediaProvider(undefined, "image", RUN)).toEqual({ provider: "xai", apiKey: "xai-key", forced: false });
  });

  it("an explicit paid backend is refused in the run, naming the switch", async () => {
    creds = { openai: OPENAI_KEY };
    setSessionImageEngine(RUN, "chatgpt");
    expect(await resolveMediaProvider("openai", "image", RUN)).toMatchObject({ provider: "openai", forced: true, refusal: expect.stringContaining("Allow paid API keys for images and video") });
  });

  it("a sign-in is free in the run, as in a chat", async () => {
    creds = { codex: CHATGPT };
    setSessionImageEngine(RUN, "chatgpt");
    expect(await resolveMediaProvider(undefined, "image", RUN)).toEqual({ provider: "codex", apiKey: TOKEN, forced: false });
  });
});
