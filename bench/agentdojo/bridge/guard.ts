// Whole-stack guard — runs each AgentDojo tool CALL through LAX's real pre-dispatch
// defenses and each tool OUTPUT through LAX's real content sanitizer + taint
// recorder. Every function below is imported from src/, not reimplemented, so the
// benchmark measures the shipped stack.
//
// Config axes:
//   off          — no defense (baseline ASR/utility).
//   faithful     — LAX as shipped: ARI kernel (workspace-assistant preset) + lineage
//                  egress + canary + threat chain; sanitizer wraps web-class reads
//                  only; taint recorded only on secret-shaped output (prod behavior).
//   sanitize-all — faithful + the sanitizer (delimiting) extended to EVERY untrusted
//                  read (email/file/review/chat/calendar). Isolates "what broader
//                  sanitizer coverage buys" without changing the taint model.
//   taint-all    — faithful + every untrusted read recorded as web taint, so the
//                  kernel's behavioral rules + lineage egress gate fire on sinks.
//                  Max security / min utility ceiling.

import { checkOutboundRequest, checkOutboundPayload } from "../../../src/tools/http-egress-guard.js";
import { wrapExternalContent } from "../../../src/sanitize.js";
import { recordSensitiveRead, detectSecretsInOutput } from "../../../src/data-lineage.js";
import { getKernelTaintSources, checkEgressTaintWithPayload, clearSessionTaint } from "../../../src/data-lineage-taint.js";
import { generateCanaries, registerSessionCanaries, checkCanariesInPayload } from "../../../src/threat/canaries.js";
import { ThreatEngine } from "../../../src/threat/threat-engine.js";
import { buildRunFirewall, evaluateRun, type RunFirewall } from "./ari-runtime.js";
import { specFor } from "./tool-map.js";

export type ConfigName = "off" | "faithful" | "sanitize-all" | "taint-all";

interface RunState {
  config: ConfigName;
  rf: RunFirewall | null;
  te: ThreatEngine | null;
  canaries: string[];
}

const runs = new Map<string, RunState>();
let THREAT_DATA_DIR = "";
export function setThreatDataDir(dir: string) { THREAT_DATA_DIR = dir; }

export interface CallVerdict { allowed: boolean; stage?: string; reason?: string }

// Begin an episode. Returns canaries so the LLM shim can plant them in the system
// prompt (the canary egress gate then proves a system-prompt leak deterministically).
export function beginRun(runId: string, config: ConfigName): { canaries: string[] } {
  clearSessionTaint(runId);
  const canaries = config === "off" ? [] : generateCanaries();
  let rf: RunFirewall | null = null;
  let te: ThreatEngine | null = null;
  if (config !== "off") {
    rf = buildRunFirewall();
    try { te = new ThreatEngine(THREAT_DATA_DIR, runId); } catch { te = null; }
    registerSessionCanaries(runId, canaries);
  }
  runs.set(runId, { config, rf, te, canaries });
  return { canaries };
}

export function endRun(runId: string): void {
  runs.delete(runId);
  clearSessionTaint(runId);
}

// Classify an ARI deny into a stage so the report can separate "preset blanket
// deny" from "injection-triggered deny" — the load-bearing distinction.
function ariStage(reason: string): string {
  if (/preset/i.test(reason)) return "preset-policy";
  if (/behavioral|quarantin/i.test(reason)) return "taint-behavioral";
  if (/grant|capability|not allowed/i.test(reason)) return "arikernel-policy";
  return "arikernel";
}

export async function guardToolCall(runId: string, toolName: string, args: Record<string, unknown>): Promise<CallVerdict> {
  const run = runs.get(runId);
  if (!run || run.config === "off" || !run.rf) return { allowed: true };
  const { spec } = specFor(toolName);

  // Threat-engine "restricted" latch (mirror makeThreatEnginePack): once a prior
  // threat trips it, external/egress tools are blocked.
  if (spec.egress && run.te) {
    try { if (run.te.isRestricted()) return { allowed: false, stage: "threat", reason: "external tools restricted after prior threat" }; } catch { /* ignore */ }
  }

  // ARI kernel.
  const taint = getKernelTaintSources(runId);
  const ari = await evaluateRun(run.rf, spec.ariClass, spec.action, args, taint);
  if (!ari.allowed) return { allowed: false, stage: ariStage(ari.reason), reason: ari.reason };

  // Egress-only gates: data-lineage taint floor, then canary tripwire.
  if (spec.egress) {
    const payload = safeJson(args);
    const lin = checkEgressTaintWithPayload(runId, payload);
    if (lin.blocked) return { allowed: false, stage: "data-lineage", reason: lin.reason };
    const canary = checkCanariesInPayload(runId, payload);
    if (canary) return { allowed: false, stage: "canary", reason: canary };
  }
  return { allowed: true };
}

export function guardToolOutput(runId: string, toolName: string, args: Record<string, unknown>, output: string): { output: string } {
  const run = runs.get(runId);
  if (!run || run.config === "off") return { output };
  const { spec } = specFor(toolName);
  let out = output;

  // SANITIZE: faithful wraps only web-class reads; sanitize-all/taint-all wrap any untrusted read.
  const wrap = run.config === "faithful" ? !!spec.webClass : !!spec.untrusted;
  if (wrap) out = wrapExternalContent(output, spec.source || "tool_result", { tool: toolName });

  // TAINT: taint-all marks every untrusted read as web; faithful/sanitize-all use
  // the prod rule (taint only when the output is secret-shaped).
  if (spec.untrusted || spec.webClass) {
    if (run.config === "taint-all") {
      recordSensitiveRead(runId, "web", toolName);
    } else {
      try {
        const det = detectSecretsInOutput(output);
        if (det.matched) recordSensitiveRead(runId, "secret", `${toolName}:${det.kinds.join(",")}`, output);
      } catch { /* ignore */ }
    }
  }

  // THREAT chain update (post-call) — drives read-sensitive→egress detection + restricted latch.
  if (run.te) { try { run.te.evaluateToolResult(toolName, args, output, true); } catch { /* ignore */ } }
  return { output: out };
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

// Stateless egress DLP scan for the SHADE-Arena control layer: scan a tool call's
// outbound args for secret-shaped (credentials/keys) and — when the financial
// guard is enabled — financial-account data. Content-based, so it's tool-agnostic
// and needs no per-run state. This is LAX's egress-guard layer as a control.
export function egressScan(tool: string, args: Record<string, unknown>): CallVerdict {
  const text = Object.values(args)
    .map((v) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : ""))
    .filter(Boolean).join("\n") || safeJson(args);
  const url = typeof args.url === "string" ? args.url : "";
  const block = url
    ? checkOutboundRequest({ url, method: "POST", body: text })
    : checkOutboundPayload(`shade:${tool}`, text);
  if (block) return { allowed: false, stage: String(block.meta?.blocked_by ?? "egress-guard"), reason: block.message };
  return { allowed: true };
}
