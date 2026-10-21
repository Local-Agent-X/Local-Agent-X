// Typed client for the agentxos account API (app.agentxos.ai), shared by the desktop
// and the phone: device-code login (RFC 8628), device registration, pairing (the desktop
// issues a QR challenge and can revoke; the phone redeems a scanned one), discovering
// the paired peer, and session renewal. Authenticated calls send the session token as
// `Authorization: Bearer` (apps/web/lib/require-session.ts accepts it).
//
// Pure over an injected `fetch` + base URL, so it unit-tests offline against a fake
// fetch; networked calls only run on a real device. Each method throws an ApiError
// carrying the route's actionable message (constitution §16) so the caller can show it.

/** The agentxos account API base. Each app overrides it for staging/dev. */
export const DEFAULT_ACCOUNT_API_URL = "https://app.agentxos.ai";

/** A failed API call — carries the HTTP status + the route's machine code + message.
 *  Status 0 is a network/DNS/TLS failure (code `network_error`), worth retrying. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export interface StartedDeviceCode {
  deviceCode: string;
  userCode: string;
  userCodeDisplay: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export type DeviceCodePoll =
  | { status: "pending" }
  | { status: "approved"; token: string; accountId: string; email: string }
  | { status: "expired" }
  | { status: "denied" };

export interface RegisteredDevice {
  deviceId: string;
  created: boolean;
}

/** A pairing challenge issued to a desktop; it renders `qrPayload` as a QR. */
export interface IssuedPairing {
  code: string;
  expiresAt: number;
  /** The JSON string the desktop renders as a QR (packages/data qr-payload contract). */
  qrPayload: string;
}

/** A challenge redeemed by a phone; `pairingId` names the pairing in listPairings. */
export interface RedeemedPairing {
  pairingId: string;
}

export interface PairingEntry {
  pairingId: string;
  desktopDeviceId: string;
  phoneDeviceId: string;
  desktopLabel: string | null;
  phoneLabel: string | null;
  createdAt: number;
}

/** The fetch surface this client needs (the Node and React Native globals satisfy it). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class AgentxosApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(baseUrl: string = DEFAULT_ACCOUNT_API_URL, fetchImpl: FetchLike = fetch) {
    // Normalize: drop a trailing slash so we don't build "//api".
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    this.fetchImpl = fetchImpl;
  }

  /** Begin device-code login. Unauthenticated — no token yet. */
  startDeviceCode(): Promise<StartedDeviceCode> {
    return this.post<StartedDeviceCode>("/api/device-code/start", {});
  }

  /** Poll for approval. Unauthenticated — the deviceCode secret is the credential. */
  pollDeviceCode(deviceCode: string): Promise<DeviceCodePoll> {
    return this.post<DeviceCodePoll>("/api/device-code/poll", { deviceCode });
  }

  /** Register this device under the account. `publicKey` is its public identity; the
   *  private material never leaves the device. Idempotent on publicKey. */
  registerDevice(
    token: string,
    input: { kind: "desktop" | "phone"; publicKey: string; label: string },
  ): Promise<RegisteredDevice> {
    return this.post<RegisteredDevice>("/api/devices/register", input, token);
  }

  /** Request a one-time pairing challenge for a desktop; it renders `qrPayload` as a QR. */
  requestPairingChallenge(token: string, desktopDeviceId: string): Promise<IssuedPairing> {
    return this.post<IssuedPairing>("/api/pairings/challenge", { desktopDeviceId }, token);
  }

  /** Redeem a scanned pairing code. `connectUrl` is the absolute redeem endpoint carried
   *  in the QR payload — POSTed verbatim so the phone never hardcodes the route. */
  redeemPairing(
    token: string,
    connectUrl: string,
    input: { code: string; phoneDeviceId: string },
  ): Promise<RedeemedPairing> {
    return this.request<RedeemedPairing>(connectUrl, "POST", input, token);
  }

  /** List the account's active pairings — how each device discovers its paired peer. */
  async listPairings(token: string): Promise<PairingEntry[]> {
    const data = await this.get<{ pairings?: PairingEntry[] }>("/api/pairings", token);
    return data.pairings ?? [];
  }

  /** Swap a still-valid session token for a fresh one. The server renews only for a
   *  device of this account that is still paired, so a revoked pairing ends the chain. */
  async refreshSession(token: string, deviceId: string): Promise<string> {
    const data = await this.post<{ token: string }>("/api/session/refresh", { deviceId }, token);
    return data.token;
  }

  /** Revoke a pairing — the desktop's "Disconnect phone" action. Server-side and permanent;
   *  the phone can only rejoin by scanning a new QR (constitution §11, no remote add). */
  async revokePairing(token: string, pairingId: string): Promise<void> {
    await this.post<{ ok: boolean }>("/api/devices/revoke", { pairingId }, token);
  }

  private post<T>(path: string, body: unknown, token?: string): Promise<T> {
    return this.request<T>(this.baseUrl + path, "POST", body, token);
  }

  private get<T>(path: string, token?: string): Promise<T> {
    return this.request<T>(this.baseUrl + path, "GET", undefined, token);
  }

  private async request<T>(url: string, method: "GET" | "POST", body: unknown, token?: string): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers["authorization"] = `Bearer ${token}`;

    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);

    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch (e) {
      throw new ApiError(0, "network_error", `Couldn't reach agentxos: ${(e as Error).message}`);
    }

    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const code = typeof data?.code === "string" ? data.code : `http_${res.status}`;
      const message = typeof data?.message === "string" ? data.message : `Request failed (${res.status}).`;
      throw new ApiError(res.status, code, message);
    }
    return (data ?? {}) as T;
  }
}
