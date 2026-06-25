// Typed client for the agentxos account API (app.agentxos.ai). The desktop SERVER
// process calls these to: log in via the device-code flow (RFC 8628), register this
// machine as a device, request a pairing QR, and discover which phone paired. It can
// set request headers (unlike a browser/RN client), so authenticated calls send the
// session token as `Authorization: Bearer` — the routes accept that (require-session.ts).
//
// Pure over an injected `fetch` + base URL, so it unit-tests offline against a fake
// fetch. Networked calls only run on the real device. Each method throws an
// ApiError carrying the route's actionable message (constitution: surface failures,
// never swallow) so the caller can show it.

/** The agentxos account API base. Override via LAX_ACCOUNT_API_URL for staging/dev. */
export const DEFAULT_ACCOUNT_API_URL = "https://app.agentxos.ai";

/** A failed API call — carries the HTTP status + the route's machine code + message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
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

export interface IssuedPairing {
  code: string;
  expiresAt: number;
  /** The JSON string the desktop renders as a QR (qr-payload.ts contract). */
  qrPayload: string;
}

export interface PairingEntry {
  pairingId: string;
  desktopDeviceId: string;
  phoneDeviceId: string;
  desktopLabel: string | null;
  phoneLabel: string | null;
  createdAt: number;
}

/** The fetch surface this client needs (the Node global `fetch` satisfies it). */
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

  /** Register this machine under the account. `publicKey` is the device's ed25519
   *  public key; the private key never leaves the machine. Idempotent on publicKey. */
  registerDevice(
    token: string,
    input: { kind: "desktop" | "phone"; publicKey: string; label: string },
  ): Promise<RegisteredDevice> {
    return this.post<RegisteredDevice>("/api/devices/register", input, token);
  }

  /** Request a one-time pairing challenge for this desktop; render `qrPayload` as a QR. */
  requestPairingChallenge(token: string, desktopDeviceId: string): Promise<IssuedPairing> {
    return this.post<IssuedPairing>("/api/pairings/challenge", { desktopDeviceId }, token);
  }

  /** List the account's active pairings — how the desktop discovers its paired phone. */
  async listPairings(token: string): Promise<PairingEntry[]> {
    const data = await this.get<{ pairings: PairingEntry[] }>("/api/pairings", token);
    return data.pairings;
  }

  private async post<T>(path: string, body: unknown, token?: string): Promise<T> {
    return this.request<T>(path, "POST", body, token);
  }

  private async get<T>(path: string, token?: string): Promise<T> {
    return this.request<T>(path, "GET", undefined, token);
  }

  private async request<T>(path: string, method: "GET" | "POST", body: unknown, token?: string): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers["authorization"] = `Bearer ${token}`;

    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      // Network/DNS/TLS failure — surface as an actionable, retryable error.
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
