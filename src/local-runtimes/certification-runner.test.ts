import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { certifyLocalModel, hasPublishedCertification } from "./certification-runner.js";
import { LocalCertificationStore } from "./certification-store.js";
import type {
  CertificationIdentity,
  CertificationRequest,
  CertificationResponse,
  LocalModelCertification,
} from "./certification-types.js";
import { CERTIFICATION_SCENARIOS } from "./certification-types.js";
import type { LocalRuntimeInfo } from "./types.js";

const runtime: LocalRuntimeInfo = {
  kind: "openai-compat",
  id: "openai-compat@127.0.0.1:1234",
  label: "Fixture Runtime",
  endpoint: { baseUrl: "http://127.0.0.1:1234", origin: "auto" },
  chatBaseUrl: "http://127.0.0.1:1234/v1",
  models: [{ id: "fixture-model", contextWindow: 8192, tools: null }],
  refreshedAt: 1,
};

const identity: CertificationIdentity = {
  runtimeVersion: "fixture-runtime-1",
  modelDigest: "sha256:fixture-model-1",
};

class MemoryStore {
  readonly entries = new Map<string, LocalModelCertification>();

  read(hash: string): LocalModelCertification | null {
    return this.entries.get(hash) ?? null;
  }

  write(result: LocalModelCertification): void {
    this.entries.set(result.fingerprint.hash, result);
  }
}

function userText(request: CertificationRequest): string {
  const messages = request.body.messages;
  if (!Array.isArray(messages)) return "";
  return messages.map((entry) => {
    if (!entry || typeof entry !== "object") return "";
    const content = (entry as { content?: unknown }).content;
    return typeof content === "string" ? content : "";
  }).join("\n");
}

function successfulResponse(request: CertificationRequest): CertificationResponse {
  const messages = Array.isArray(request.body.messages) ? request.body.messages : [];
  if (request.body.response_format) {
    return { status: 200, body: { choices: [{ message: { content: "{\"ok\":true}" } }] } };
  }
  if (request.body.tools) {
    return {
      status: 200,
      body: { choices: [{ message: { tool_calls: [{
        type: "function",
        function: { name: "lax_certification_probe", arguments: "{\"ok\":true}" },
      }] } }] },
    };
  }
  const hasToolResult = messages.some((entry) => (
    entry && typeof entry === "object" && (entry as { role?: unknown }).role === "tool"
  ));
  if (hasToolResult) {
    return { status: 200, body: { choices: [{ message: { content: "LAX_CERT_CONT_91A7" } }] } };
  }
  if (userText(request).length > 4_000) {
    return { status: 200, body: { choices: [{ message: { content: "LAX_CERT_CTX_62CE" } }] } };
  }
  return { status: 200, body: { choices: [{ message: { content: "LAX_CERT_BASE_4D2F" } }] } };
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("local model certification", () => {
  it("runs the five bounded content-free scenarios without mutating routing state", async () => {
    const requests: CertificationRequest[] = [];
    const before = structuredClone(runtime);
    const result = await certifyLocalModel({ runtime, model: "fixture-model" }, {
      store: new MemoryStore(),
      resolveIdentity: async () => identity,
      transport: async (request) => {
        requests.push(request);
        return successfulResponse(request);
      },
    });

    expect(result.passedCount).toBe(5);
    expect(result.callCount).toBe(5);
    expect(requests).toHaveLength(5);
    expect(requests.every((request) => request.body.max_tokens === 256)).toBe(true);
    expect(runtime).toEqual(before);
  });

  it("publishes only a complete reusable certification for the exact discovery snapshot", async () => {
    const completeRuntime = structuredClone(runtime);
    const complete = await certifyLocalModel({ runtime: completeRuntime, model: "fixture-model" }, {
      store: new MemoryStore(),
      resolveIdentity: async () => identity,
      transport: async (request) => successfulResponse(request),
    });
    expect(complete.passedCount).toBe(5);
    expect(hasPublishedCertification(completeRuntime, completeRuntime.models[0]!)).toBe(true);
    const unpublishedRuntime = structuredClone(runtime);
    expect(hasPublishedCertification(unpublishedRuntime, unpublishedRuntime.models[0]!)).toBe(false);

    const cachedRuntime = structuredClone(runtime);
    const sharedStore = new MemoryStore();
    const persisted = await certifyLocalModel({ runtime: cachedRuntime, model: "fixture-model" }, {
      store: sharedStore,
      resolveIdentity: async () => identity,
      transport: async (request) => successfulResponse(request),
    });
    const restartedRuntime = structuredClone(runtime);
    expect(sharedStore.read(persisted.fingerprint.hash)?.passedCount).toBe(5);
    expect(hasPublishedCertification(restartedRuntime, restartedRuntime.models[0]!)).toBe(false);
    const cached = await certifyLocalModel({ runtime: restartedRuntime, model: "fixture-model" }, {
      store: sharedStore,
      resolveIdentity: async () => identity,
      transport: async () => { throw new Error("cached evidence must not run scenarios"); },
    });
    expect(cached.passedCount).toBe(5);
    expect(hasPublishedCertification(restartedRuntime, restartedRuntime.models[0]!)).toBe(true);

    completeRuntime.kind = "ollama";
    expect(hasPublishedCertification(completeRuntime, completeRuntime.models[0]!)).toBe(false);
    completeRuntime.kind = "openai-compat";
    completeRuntime.models[0]!.contextWindow = 16384;
    expect(hasPublishedCertification(completeRuntime, completeRuntime.models[0]!)).toBe(false);
    completeRuntime.models[0]!.contextWindow = 8192;
    completeRuntime.models[0]!.tools = true;
    expect(hasPublishedCertification(completeRuntime, completeRuntime.models[0]!)).toBe(false);
    completeRuntime.models[0]!.tools = null;
    completeRuntime.endpoint.baseUrl = "http://127.0.0.1:9999";
    expect(hasPublishedCertification(completeRuntime, completeRuntime.models[0]!)).toBe(false);
    completeRuntime.endpoint.baseUrl = "http://127.0.0.1:1234";
    completeRuntime.chatBaseUrl = "http://127.0.0.1:1234/other";
    expect(hasPublishedCertification(completeRuntime, completeRuntime.models[0]!)).toBe(false);
    completeRuntime.chatBaseUrl = "http://127.0.0.1:1234/v1";
    completeRuntime.models[0]!.id = "replaced-model";
    expect(hasPublishedCertification(completeRuntime, completeRuntime.models[0]!)).toBe(false);
    completeRuntime.models[0]!.id = "fixture-model";
    expect(hasPublishedCertification(completeRuntime, completeRuntime.models[0]!, {
      version: 2,
      scenarios: CERTIFICATION_SCENARIOS,
    })).toBe(false);
    expect(hasPublishedCertification(completeRuntime, completeRuntime.models[0]!, {
      version: 1,
      scenarios: CERTIFICATION_SCENARIOS.slice(0, -1),
    })).toBe(false);
    expect(hasPublishedCertification(completeRuntime, completeRuntime.models[0]!)).toBe(true);

    const partialRuntime = structuredClone(runtime);
    await certifyLocalModel({ runtime: partialRuntime, model: "fixture-model" }, {
      store: new MemoryStore(),
      resolveIdentity: async () => identity,
      transport: async () => ({ status: 200, body: { choices: [{ message: { content: "wrong" } }] } }),
    });
    expect(hasPublishedCertification(partialRuntime, partialRuntime.models[0]!)).toBe(false);

    const unknownIdentityRuntime = structuredClone(runtime);
    await certifyLocalModel({ runtime: unknownIdentityRuntime, model: "fixture-model" }, {
      store: new MemoryStore(),
      resolveIdentity: async () => ({ runtimeVersion: null, modelDigest: "known" }),
      transport: async (request) => successfulResponse(request),
    });
    expect(hasPublishedCertification(unknownIdentityRuntime, unknownIdentityRuntime.models[0]!)).toBe(false);
  });

  it("invalidates reuse when the runtime/model fingerprint changes", async () => {
    const store = new MemoryStore();
    let calls = 0;
    let currentIdentity = identity;
    const run = () => certifyLocalModel({ runtime, model: "fixture-model" }, {
      store,
      resolveIdentity: async () => currentIdentity,
      transport: async (request) => {
        calls += 1;
        return successfulResponse(request);
      },
    });
    const first = await run();
    expect((await run()).fingerprint.hash).toBe(first.fingerprint.hash);
    expect(calls).toBe(5);

    currentIdentity = { ...identity, modelDigest: "sha256:fixture-model-2" };
    const changed = await run();
    expect(changed.fingerprint.hash).not.toBe(first.fingerprint.hash);
    expect(calls).toBe(10);
  });

  it("never reuses a result when runtime version or model digest is unknown", async () => {
    const store = new MemoryStore();
    let calls = 0;
    const run = () => certifyLocalModel({ runtime, model: "fixture-model" }, {
      store,
      resolveIdentity: async () => ({ runtimeVersion: null, modelDigest: "known" }),
      transport: async (request) => {
        calls += 1;
        return successfulResponse(request);
      },
    });
    expect((await run()).fingerprint.reusable).toBe(false);
    expect((await run()).fingerprint.reusable).toBe(false);
    expect(calls).toBe(10);
  });

  it("persists only aggregate facts and hashes, never certification content or identity material", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lax-cert-store-"));
    tempDirs.push(dir);
    const file = join(dir, "certifications.json");
    await certifyLocalModel({
      runtime: {
        ...runtime,
        endpoint: { baseUrl: "http://private-runtime-name:1234", origin: "manual" },
      },
      model: "private-model-name",
    }, {
      store: new LocalCertificationStore(file),
      resolveIdentity: async () => ({
        runtimeVersion: "private-runtime-version",
        modelDigest: "private-model-digest",
      }),
      transport: async (request) => successfulResponse(request),
    });
    const saved = readFileSync(file, "utf8");
    for (const forbidden of [
      "LAX_CERT", "Reply with", "private-runtime-name", "private-model-name",
      "private-runtime-version", "private-model-digest", "tool_calls", "messages",
    ]) {
      expect(saved).not.toContain(forbidden);
    }
    expect(saved).toContain("baseline_marker");
    expect(saved).toMatch(/[a-f0-9]{64}/);
  });

  it("classifies context rejection without storing the response body", async () => {
    const result = await certifyLocalModel({ runtime, model: "fixture-model" }, {
      store: new MemoryStore(),
      resolveIdentity: async () => identity,
      transport: async (request) => userText(request).length > 4_000
        ? { status: 413, body: { secret_error_body: "do not persist" } }
        : successfulResponse(request),
    });
    expect(result.scenarios.context_degradation).toMatchObject({
      passed: false,
      calls: 1,
      failure: "context_rejected",
    });
  });

  it("stops after one unavailable-runtime call and marks remaining scenarios without calls", async () => {
    let calls = 0;
    const store = new MemoryStore();
    const result = await certifyLocalModel({ runtime, model: "fixture-model" }, {
      store,
      resolveIdentity: async () => identity,
      transport: async () => {
        calls += 1;
        throw new Error("ECONNREFUSED with private details");
      },
    });
    expect(calls).toBe(1);
    expect(result.callCount).toBe(1);
    expect(store.entries.size).toBe(0);
    expect(Object.values(result.scenarios).every((scenario) => (
      scenario.failure === "runtime_unavailable"
    ))).toBe(true);
  });

  it("serializes certifications globally so local inference concurrency stays one", async () => {
    let active = 0;
    let maxActive = 0;
    const transport = async (request: CertificationRequest): Promise<CertificationResponse> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return successfulResponse(request);
    };
    await Promise.all([
      certifyLocalModel({ runtime, model: "fixture-model-a" }, {
        store: new MemoryStore(), resolveIdentity: async () => identity, transport,
      }),
      certifyLocalModel({ runtime, model: "fixture-model-b" }, {
        store: new MemoryStore(), resolveIdentity: async () => identity, transport,
      }),
    ]);
    expect(maxActive).toBe(1);
  });

  it("does not start calls after the 150 second model budget is exhausted", async () => {
    let now = 0;
    let calls = 0;
    const result = await certifyLocalModel({ runtime, model: "fixture-model" }, {
      store: new MemoryStore(),
      now: () => now,
      resolveIdentity: async () => identity,
      transport: async (request) => {
        calls += 1;
        now += 50_000;
        return successfulResponse(request);
      },
    });
    expect(calls).toBe(3);
    expect(result.callCount).toBe(3);
    expect(result.scenarios.tool_result_continuation).toMatchObject({ calls: 0, failure: "timeout" });
    expect(result.scenarios.context_degradation).toMatchObject({ calls: 0, failure: "timeout" });
  });
});
