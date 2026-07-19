import { afterEach, describe, expect, it, vi } from "vitest";
import { certifyLocalModel } from "./certification-runner.js";
import type {
  CertificationRequest,
  CertificationResponse,
  LocalModelCertification,
} from "./certification-types.js";
import type { LocalRuntimeInfo } from "./types.js";

const runtime: LocalRuntimeInfo = {
  kind: "openai-compat",
  id: "openai-compat@127.0.0.1:1234",
  label: "Fixture",
  endpoint: { baseUrl: "http://127.0.0.1:1234", origin: "auto" },
  chatBaseUrl: "http://127.0.0.1:1234/v1",
  models: [],
  refreshedAt: 1,
};

class ObservedStore {
  readonly values = new Map<string, LocalModelCertification>();
  writes = 0;
  read(hash: string): LocalModelCertification | null { return this.values.get(hash) ?? null; }
  write(value: LocalModelCertification): void {
    this.writes += 1;
    this.values.set(value.fingerprint.hash, value);
  }
}

function text(request: CertificationRequest): string {
  const messages = Array.isArray(request.body.messages) ? request.body.messages : [];
  return messages.map((entry) => (
    entry && typeof entry === "object" && typeof (entry as { content?: unknown }).content === "string"
      ? (entry as { content: string }).content
      : ""
  )).join("\n");
}

function success(request: CertificationRequest): CertificationResponse {
  const messages = Array.isArray(request.body.messages) ? request.body.messages : [];
  if (request.body.response_format) {
    return { status: 200, body: { choices: [{ message: { content: "{\"ok\":true}" } }] } };
  }
  if (request.body.tools) {
    return { status: 200, body: { choices: [{ message: { tool_calls: [{
      type: "function",
      function: { name: "lax_certification_probe", arguments: "{\"ok\":true}" },
    }] } }] } };
  }
  if (messages.some((entry) => entry && typeof entry === "object" && (entry as { role?: unknown }).role === "tool")) {
    return { status: 200, body: { choices: [{ message: { content: "LAX_CERT_CONT_91A7" } }] } };
  }
  return text(request).length > 4_000
    ? { status: 200, body: { choices: [{ message: { content: "LAX_CERT_CTX_62CE" } }] } }
    : { status: 200, body: { choices: [{ message: { content: "LAX_CERT_BASE_4D2F" } }] } };
}

const stableIdentity = async () => ({ runtimeVersion: "1", modelDigest: "digest" });

afterEach(() => {
  vi.useRealTimers();
});

describe("certification fail-closed deadlines and caching", () => {
  it("does no work and persists nothing when pre-aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const store = new ObservedStore();
    const identity = vi.fn(stableIdentity);
    const transport = vi.fn(async (request: CertificationRequest) => success(request));
    const result = await certifyLocalModel({ runtime, model: "m", signal: controller.signal }, {
      store, resolveIdentity: identity, transport,
    });
    expect(identity).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(store.writes).toBe(0);
    expect(Object.values(result.scenarios).every((entry) => entry.failure === "aborted")).toBe(true);
  });

  it("hard-times out a transport that ignores AbortSignal and releases the global queue", async () => {
    vi.useFakeTimers();
    const firstStore = new ObservedStore();
    const secondStore = new ObservedStore();
    const first = certifyLocalModel({ runtime, model: "hung" }, {
      store: firstStore,
      resolveIdentity: stableIdentity,
      transport: async () => new Promise<CertificationResponse>(() => {}),
    });
    const second = certifyLocalModel({ runtime, model: "next" }, {
      store: secondStore,
      resolveIdentity: stableIdentity,
      transport: async (request) => success(request),
    });
    await vi.advanceTimersByTimeAsync(30_001);
    const [timedOut, next] = await Promise.all([first, second]);
    expect(timedOut.scenarios.baseline_marker.failure).toBe("timeout");
    expect(firstStore.writes).toBe(0);
    expect(next.passedCount).toBe(5);
    expect(secondStore.writes).toBe(1);
  });

  it("hard-times out identity lookup that ignores AbortSignal, then continues non-reusably", async () => {
    vi.useFakeTimers();
    const store = new ObservedStore();
    const pending = certifyLocalModel({ runtime, model: "m" }, {
      store,
      resolveIdentity: async () => new Promise(() => {}),
      transport: async (request) => success(request),
    });
    await vi.advanceTimersByTimeAsync(30_001);
    const result = await pending;
    expect(result.fingerprint.reusable).toBe(false);
    expect(result.passedCount).toBe(5);
  });
});

describe("certification HTTP failure classification", () => {
  it.each([
    [401, "auth_rejected"],
    [403, "auth_rejected"],
    [500, "server_error"],
    [503, "server_error"],
    [429, "transport_error"],
  ] as const)("maps status %i without caching it", async (status, failure) => {
    const store = new ObservedStore();
    const result = await certifyLocalModel({ runtime, model: `m-${status}` }, {
      store,
      resolveIdentity: stableIdentity,
      transport: async () => ({ status, body: { error: { code: "not_context" } } }),
    });
    expect(result.scenarios.baseline_marker.failure).toBe(failure);
    expect(result.callCount).toBe(1);
    expect(store.writes).toBe(0);
  });

  it.each([
    [400, { error: { code: "generic_bad_request" } }, "bad_response"],
    [400, { error: { code: "context_length_exceeded" } }, "context_rejected"],
    [413, null, "context_rejected"],
  ] as const)("classifies context response %i from actual context signals", async (status, body, failure) => {
    const result = await certifyLocalModel({ runtime, model: `ctx-${status}-${failure}` }, {
      store: new ObservedStore(),
      resolveIdentity: stableIdentity,
      transport: async (request) => text(request).length > 4_000
        ? { status, body }
        : success(request),
    });
    expect(result.scenarios.context_degradation.failure).toBe(failure);
  });
});

