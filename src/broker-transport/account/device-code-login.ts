// The device-code login loop (RFC 8628 client side): start a grant, show the user the
// short code + the URL to approve it at, then poll until approved/expired/denied. Pure
// orchestration over the api client + an injected clock/sleep, so it unit-tests offline
// (a fake api that returns pending→approved, a sleep that resolves immediately).
//
// The desktop SERVER process runs this; `onPrompt` is how the surface (an account page,
// a log line, a tray notice) shows the user what to type and where. On success the
// caller persists the token + identity and registers the device.

import type { DeviceCodePoll, StartedDeviceCode } from "./api-client.js";

/** The subset of the api client this loop needs (so tests inject a fake). */
export interface DeviceCodeApi {
  startDeviceCode(): Promise<StartedDeviceCode>;
  pollDeviceCode(deviceCode: string): Promise<DeviceCodePoll>;
}

/** What the surface shows the user to complete approval. */
export interface LoginPrompt {
  userCodeDisplay: string;
  verificationUri: string;
  verificationUriComplete: string;
}

export interface DeviceCodeLoginDeps {
  api: DeviceCodeApi;
  /** Show the user the code + where to approve it (called once, right after start). */
  onPrompt: (prompt: LoginPrompt) => void;
  /** Sleep for the poll interval (injected so tests don't wait real time). */
  sleep: (ms: number) => Promise<void>;
  /** Clock for the overall expiry deadline. */
  now: () => number;
  /** Optional cancel (user closed the dialog / app shutdown). */
  signal?: { readonly aborted: boolean };
}

export type LoginResult =
  | { ok: true; token: string; accountId: string; email: string }
  | { ok: false; reason: "expired" | "denied" | "aborted" };

/**
 * Run the full device-code login. Returns the session token + account on success, or an
 * actionable terminal reason. Never throws on a normal terminal state; an api/network
 * error propagates (the caller decides whether to retry the whole flow).
 */
export async function deviceCodeLogin(deps: DeviceCodeLoginDeps): Promise<LoginResult> {
  const started = await deps.api.startDeviceCode();
  deps.onPrompt({
    userCodeDisplay: started.userCodeDisplay,
    verificationUri: started.verificationUri,
    verificationUriComplete: started.verificationUriComplete,
  });

  const intervalMs = Math.max(1, started.interval) * 1000;
  const deadline = deps.now() + Math.max(1, started.expiresIn) * 1000;

  while (deps.now() < deadline) {
    if (deps.signal?.aborted) return { ok: false, reason: "aborted" };
    await deps.sleep(intervalMs);
    if (deps.signal?.aborted) return { ok: false, reason: "aborted" };

    const poll = await deps.api.pollDeviceCode(started.deviceCode);
    if (poll.status === "approved") {
      return { ok: true, token: poll.token, accountId: poll.accountId, email: poll.email };
    }
    if (poll.status === "expired") return { ok: false, reason: "expired" };
    if (poll.status === "denied") return { ok: false, reason: "denied" };
    // pending → keep polling until the deadline
  }
  return { ok: false, reason: "expired" };
}
