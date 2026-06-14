// Per-run ARI firewall — a faithful re-expression of src/ari-kernel/lifecycle.ts
// (startAriKernel) + src/ari-kernel/evaluate.ts (ariEvaluate), but built FRESH
// per AgentDojo episode instead of once-global.
//
// Why per-run: the kernel keeps one run-state (sticky taint + behavioral-rule
// window + quarantine latch) per Firewall instance. An AgentDojo episode is one
// independent "conversation"; reusing a single global firewall would leak a
// quarantine tripped in episode 1 into every later episode. A fresh firewall per
// episode == a fresh LAX session, which is the honest analog.
//
// Everything load-bearing (preset, principal capabilities, host grants, no-op
// executors) is the SAME construction the production wrapper uses — imported,
// not copied — so the number measures the real kernel, not a mis-boot.

import { getPreset } from "@arikernel/core";
import type { PresetId, CapabilityClass } from "@arikernel/core";
import { CAPABILITY_CLASS_MAP, deriveCapabilityClass } from "@arikernel/core";
import { TokenStore, createFirewall } from "@arikernel/runtime";
import type { Firewall } from "@arikernel/runtime";
import { HOST_CAPABILITY_MANIFEST, buildPrincipalCapabilities } from "../../../src/ari-kernel/manifest.js";
import { mintHostGrants } from "../../../src/ari-kernel/grants.js";

export interface RunFirewall {
  firewall: Firewall;
  grants: Map<CapabilityClass, string>;
}

const HOST_PRINCIPAL_NAME = "lax-host";

// Build a fresh, fully-configured firewall — mirror of startAriKernel minus the
// global singleton/audit-file (audit DB is omitted: the bench measures policy
// decisions, not the tamper-evident chain). Preset defaults to the production
// session default (getAriPresetForSession("default") === "workspace-assistant").
export function buildRunFirewall(preset = "workspace-assistant"): RunFirewall {
  const presetConfig = getPreset(preset as PresetId);
  const tokenStore = new TokenStore();
  const firewall = createFirewall({
    principal: {
      name: HOST_PRINCIPAL_NAME,
      capabilities: buildPrincipalCapabilities(),
    },
    policies: presetConfig.policies,
    mode: "embedded",
    tokenStore,
    hooks: { onApprovalRequired: async () => true },
  });

  const grants = mintHostGrants(tokenStore, firewall.principalInfo.id);

  // No-op executors for every manifest toolClass: ARI is gate+observer here, the
  // real tool runs in AgentDojo. Without these the kernel would try to perform
  // the I/O itself (lifecycle.ts:76-107).
  const register = (firewall as unknown as {
    registerExecutor: (e: { toolClass: string; execute: (tc: { id: string }) => Promise<unknown> }) => void;
  }).registerExecutor.bind(firewall);
  const noop = async (tc: { id: string }) => ({ callId: tc.id, success: true, durationMs: 0, taintLabels: [] });
  const classes = new Set<string>();
  for (const { toolClass } of HOST_CAPABILITY_MANIFEST) classes.add(toolClass);
  for (const toolClass of classes) {
    try { register({ toolClass, execute: noop }); } catch { /* class already registered */ }
  }

  return { firewall, grants };
}

// Per-run grant lookup — mirror of grants.ts:lookupHostGrantId but against the
// run-local grant map instead of global state.
function lookupGrant(grants: Map<CapabilityClass, string>, toolClass: string, action: string): string | undefined {
  const capClass = deriveCapabilityClass(toolClass, action);
  const mapping = CAPABILITY_CLASS_MAP[capClass];
  if (!mapping || mapping.toolClass !== toolClass) return undefined;
  if (!mapping.actions.includes(action.toLowerCase())) return undefined;
  return grants.get(capClass);
}

export interface AriDecision {
  allowed: boolean;
  reason: string;
}

// Evaluate one tool call through the run's firewall — faithful re-expression of
// evaluate.ts (ariEvaluate) with an EXPLICIT toolClass (AgentDojo tools aren't in
// LAX's TOOL_CLASS_MAP, so the lookup is supplied by the bench tool-map instead).
// Taint strings become TaintLabels exactly as evaluate.ts shapes them
// (origin:"agent", confidence:1.0) so behavioral rules see identical input.
export async function evaluateRun(
  rf: RunFirewall,
  toolClass: string,
  action: string,
  params: Record<string, unknown>,
  taintLabels: string[],
): Promise<AriDecision> {
  const execRequest: Record<string, unknown> = { toolClass, action, parameters: params };
  const grantId = lookupGrant(rf.grants, toolClass, action);
  if (grantId) execRequest.grantId = grantId;
  if (taintLabels.length > 0) {
    execRequest.taintLabels = taintLabels.map((label) => ({
      source: String(label),
      origin: "agent" as const,
      confidence: 1.0,
      addedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    }));
  }
  try {
    const result = await rf.firewall.execute(
      execRequest as unknown as Parameters<typeof rf.firewall.execute>[0],
    );
    if (!result.success) {
      return { allowed: false, reason: `[ARI] ${result.error || "denied by kernel policy"}` };
    }
    return { allowed: true, reason: "ARI allowed" };
  } catch (e) {
    return { allowed: false, reason: `[ARI] evaluation error: ${(e as Error).message}` };
  }
}
