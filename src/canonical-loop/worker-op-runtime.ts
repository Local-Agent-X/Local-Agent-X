/**
 * Pin the provider/model/runtime for a harness-submitted worker op and install
 * its adapter factory and tool runtime under the worker's OWN session.
 *
 * Shared by the two fresh-context passes the harness submits on the user's
 * behalf: the deliverable verification (verification-submit.ts) and the
 * pre-publish review (publish-review-submit.ts). They differ only in the belt
 * (tools), the system prompt, and the file boundary (security); the resolve →
 * seal → register → install sequence is one piece of code. It mirrors
 * ops/tools/shared.ts configureDelegatedRuntime, which canonical-loop cannot
 * import (see verification-submit.ts's header for the seal reason), and
 * agent-runner/run.ts is the in-module precedent for the order.
 *
 * Runs BEFORE the op becomes visible (canonicalLoopEntry), so a credential or
 * endpoint that cannot be resolved throws here and no ghost op is left behind.
 */
import { getRuntimeConfig } from "../config.js";
import { getLaxDir } from "../lax-data-dir.js";
import { getOrInitSecretsStore } from "../secrets.js";
import { resolveCredential } from "../auth/resolve.js";
import { resolveProvider } from "../agent-request/resolve-provider.js";
import type { SecurityLayer } from "../security/index.js";
import { loadToolPolicy } from "../tool-policy/index.js";
import { broadcastToSession } from "../ops/session-bridge.js";
import type { Op } from "../ops/types.js";
import type { ToolDefinition } from "../types.js";
import { createProviderAdapterFactory, resolveProviderRuntime } from "./provider-adapter-factory.js";
import { sealDelegatedRuntime } from "./runtime-integrity.js";
import { registerAdapterForOp } from "./runtime.js";
import { buildAgentRuntimeSurface, installOpToolRuntime } from "./agent-runner/runtime-surface.js";
import { readOp } from "../ops/op-store.js";
import { opCancel } from "./control-api.js";
import { isTerminalCanonicalState } from "./state-machine.js";
import { createLogger } from "../logger.js";

const logger = createLogger("canonical-loop.worker-op-runtime");

/**
 * Arm the wall-time deadline for a submitted worker op: after `ms`, a
 * still-live op is cancelled through the canonical control API. opCancel is
 * terminal-guarded and idempotent, so firing after natural completion is a
 * no-op; the timer is unref'd so it never holds the process open. It also
 * covers time spent QUEUED, which the worker's own wall clock (armed when the
 * op starts running) does not.
 */
export function armWorkerOpDeadline(opId: string, ms: number, label: string): void {
  const timer = setTimeout(() => {
    try {
      const state = readOp(opId)?.canonical?.state;
      if (state && isTerminalCanonicalState(state)) return;
      const result = opCancel(opId, `${label}-deadline`);
      if (result.ok) logger.warn(`[${label}] ${opId} exceeded maxWallTimeMs=${ms} — cancelled`);
    } catch (e) {
      logger.warn(`[${label}] deadline enforcement failed for ${opId}: ${(e as Error).message}`);
    }
  }, ms);
  timer.unref?.();
}

export interface WorkerOpRuntimeOptions {
  tools: ToolDefinition[];
  systemPrompt: string;
  security: SecurityLayer;
}

export async function configureWorkerOpRuntime(op: Op, runtimeSessionId: string, options: WorkerOpRuntimeOptions): Promise<void> {
  const dataDir = getLaxDir();
  const resolved = await resolveProvider(
    getRuntimeConfig(),
    getOrInitSecretsStore(dataDir),
    dataDir,
    op.contextPack.routing.preferredProvider,
  );
  const runtime = await resolveProviderRuntime(resolved.provider as import("../providers/provider-ids.js").ProviderId, resolved.model, {
    apiKey: resolved.apiKey,
    authSource: resolved.authSource ?? (() => { throw new Error("provider credential source was not resolved"); })(),
    customBaseURL: resolved.customBaseURL,
  });
  let authSource = runtime.identity.authSource;
  let apiKey = runtime.apiKey;
  if (runtime.identity.credentialProvider !== resolved.provider) {
    const credential = await resolveCredential(runtime.identity.credentialProvider);
    if (!credential || credential.credential !== runtime.apiKey) throw new Error("resolved runtime credential does not match its canonical credential source");
    authSource = credential.source;
    apiKey = credential.credential;
  }
  const { tools, systemPrompt, security } = options;
  const toolPolicy = loadToolPolicy(dataDir);
  const surfaceOptions = { systemPrompt, tools, security, toolPolicy, callContext: "delegated" as const };
  op.runtimeDescriptor = sealDelegatedRuntime(op.id, {
    kind: "delegated-op",
    adapter: "provider-exact",
    ...runtime.identity,
    authSource,
    sessionId: runtimeSessionId,
    surface: buildAgentRuntimeSurface(surfaceOptions, runtimeSessionId),
  });
  op.model = runtime.identity.model;
  // The op was built before the credential was known. Stamp the resolved
  // source: cost-recording.ts books the ledger row under it and
  // checkpoint-stop.ts judges the spend ceiling by it (undefined bills as
  // real spend). src/ops/context-pack-auth-source.test.ts pins this stamp.
  op.contextPack.routing.authSource = authSource;
  const factory = await createProviderAdapterFactory(op.runtimeDescriptor, {
    apiKey,
    authSource,
    customBaseURL: resolved.customBaseURL,
    sessionId: runtimeSessionId,
    systemPrompt,
    requireToolOnFirstTurn: true,
  });
  registerAdapterForOp(op.id, factory);
  installOpToolRuntime(op, {
    tools,
    security,
    toolPolicy,
    sessionId: runtimeSessionId,
    callContext: "delegated",
    onEvent: (event) => broadcastToSession(runtimeSessionId, event),
  });
}
