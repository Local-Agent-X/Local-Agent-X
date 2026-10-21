// Keeps the desktop's agentxos session alive while it is paired. The token is a 7-day
// absolute credential; without renewal the desktop's broker presence died a week after
// sign-in and the phone could only get back by someone re-signing-in at this machine.
// Once a day (checked hourly) the desktop swaps its still-valid token for a fresh one
// (POST /api/session/refresh). The server renews only for a device that is still
// paired, so revoking the pairing ends the chain.
//
// A refusal (token already expired, pairing revoked) is terminal and goes to the same
// handler as the broker's own refusal; a network failure just waits for the next check.

import { ApiError } from "./api-client.js";
import type { AccountState } from "./storage.js";

/** Renew once the token is this old. */
export const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;
/** How often the running desktop checks whether a renewal is due. */
export const RENEW_CHECK_MS = 60 * 60 * 1000;

export type RenewalRefusal = "unauthorized" | "not_paired";

export interface SessionRenewalDeps {
  loadState: () => AccountState | null;
  updateState: (patch: Partial<AccountState>) => AccountState | null;
  refresh: (token: string, deviceId: string) => Promise<string>;
  now: () => number;
  /** The server refused to renew: the session is over until the user acts. */
  onRefused: (code: RenewalRefusal) => void;
  log: (message: string) => void;
}

export type RenewalOutcome = "renewed" | "not_due" | "signed_out" | "refused" | "failed";

/** Renew the stored token if it is due. Never throws. */
export async function renewSessionIfDue(deps: SessionRenewalDeps): Promise<RenewalOutcome> {
  const state = deps.loadState();
  if (!state) return "signed_out";
  const renewedAt = state.sessionRenewedAt;
  if (renewedAt !== undefined && deps.now() - renewedAt < RENEW_AFTER_MS) return "not_due";

  let token: string;
  try {
    token = await deps.refresh(state.sessionToken, state.deviceId);
  } catch (e) {
    const refusal = refusalOf(e);
    if (refusal) {
      deps.onRefused(refusal);
      return "refused";
    }
    deps.log(`[broker-transport] session renewal failed, retrying at the next check: ${(e as Error).message}`);
    return "failed";
  }
  // A sign-out or a fresh sign-in while the request was out owns the stored token now.
  if (deps.loadState()?.sessionToken !== state.sessionToken) return "signed_out";
  deps.updateState({ sessionToken: token, sessionRenewedAt: deps.now() });
  return "renewed";
}

function refusalOf(e: unknown): RenewalRefusal | null {
  if (!(e instanceof ApiError)) return null;
  if (e.status === 401) return "unauthorized";
  if (e.status === 403) return "not_paired";
  return null;
}

export interface SessionRenewal {
  stop(): void;
}

/** Check now, then every RENEW_CHECK_MS, until stopped. */
export function startSessionRenewal(
  deps: SessionRenewalDeps,
  timers: { setInterval: typeof setInterval; clearInterval: typeof clearInterval } = { setInterval, clearInterval },
): SessionRenewal {
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    void renewSessionIfDue(deps).finally(() => {
      running = false;
    });
  };
  const handle = timers.setInterval(tick, RENEW_CHECK_MS);
  handle.unref?.();
  tick();
  return { stop: () => timers.clearInterval(handle) };
}
