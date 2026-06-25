import { describe, it, expect } from "vitest";
import { deviceCodeLogin, type DeviceCodeApi, type LoginPrompt } from "./device-code-login.js";
import type { DeviceCodePoll, StartedDeviceCode } from "./api-client.js";

const STARTED: StartedDeviceCode = {
  deviceCode: "dc-secret",
  userCode: "ABCD2345",
  userCodeDisplay: "ABCD-2345",
  verificationUri: "https://app.agentxos.ai/link",
  verificationUriComplete: "https://app.agentxos.ai/link?code=ABCD2345",
  expiresIn: 600,
  interval: 5,
};

/** A fake api that yields a scripted sequence of poll results. */
function fakeApi(polls: DeviceCodePoll[]): DeviceCodeApi {
  let i = 0;
  return {
    startDeviceCode: async () => STARTED,
    pollDeviceCode: async () => polls[Math.min(i++, polls.length - 1)],
  };
}

function deps(api: DeviceCodeApi, extra: Partial<Parameters<typeof deviceCodeLogin>[0]> = {}) {
  const prompts: LoginPrompt[] = [];
  let t = 0;
  return {
    prompts,
    args: {
      api,
      onPrompt: (p: LoginPrompt) => prompts.push(p),
      sleep: async () => {
        t += 5000;
      },
      now: () => t,
      ...extra,
    },
  };
}

describe("deviceCodeLogin", () => {
  it("prompts once, then returns the token when approval arrives", async () => {
    const api = fakeApi([
      { status: "pending" },
      { status: "approved", token: "TOK", accountId: "acct-1", email: "a@b.co" },
    ]);
    const { prompts, args } = deps(api);
    const result = await deviceCodeLogin(args);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].userCodeDisplay).toBe("ABCD-2345");
    expect(result).toEqual({ ok: true, token: "TOK", accountId: "acct-1", email: "a@b.co" });
  });

  it("returns expired when the broker reports the grant expired", async () => {
    const { args } = deps(fakeApi([{ status: "expired" }]));
    expect(await deviceCodeLogin(args)).toEqual({ ok: false, reason: "expired" });
  });

  it("returns denied when the grant is denied", async () => {
    const { args } = deps(fakeApi([{ status: "denied" }]));
    expect(await deviceCodeLogin(args)).toEqual({ ok: false, reason: "denied" });
  });

  it("stops with aborted when the signal is set", async () => {
    const signal = { aborted: false };
    const { args } = deps(fakeApi([{ status: "pending" }]), { signal });
    signal.aborted = true;
    expect(await deviceCodeLogin(args)).toEqual({ ok: false, reason: "aborted" });
  });

  it("gives up with expired once the overall deadline passes (all pending)", async () => {
    // expiresIn 600s, interval 5s → ~120 polls then the deadline forces expired.
    const { args } = deps(fakeApi([{ status: "pending" }]));
    expect(await deviceCodeLogin(args)).toEqual({ ok: false, reason: "expired" });
  });
});
