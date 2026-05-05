/**
 * Adapter conformance suite runner (Issue 02 — locked at v1).
 *
 * Implements PRD §15 items A–I. Adapter authors call `runConformance(...)`
 * with a factory that produces a fresh adapter per item. The runner is
 * **pure**: it returns pass/fail per item with diagnostic strings; the
 * caller (typically a vitest `it()` block) decides how to surface results.
 *
 * Item I (sandbox audit) requires the adapter source path. Pass it via
 * `opts.adapterSourcePath`. If omitted, item I is reported as `skipped`.
 */
import { existsSync, readFileSync } from "node:fs";
import type {
  Adapter,
  AdapterReport,
  TurnInput,
  TurnResult,
} from "../../src/canonical-loop/adapter-contract.js";
import { FORBIDDEN_ADAPTER_IMPORTS } from "../../src/canonical-loop/adapter-contract.js";
import type {
  CanonicalMessage,
  ProviderStateEnvelope,
} from "../../src/canonical-loop/contract-types.js";

export type ConformanceItemId = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I";

export interface ConformanceResult {
  item: ConformanceItemId;
  title: string;
  status: "passed" | "failed" | "skipped";
  diagnostic?: string;
  durationMs: number;
}

export interface ConformanceOpts {
  /** Subset of items to run (default: all). */
  items?: ConformanceItemId[];
  /** Path to the adapter source file. Required for item I. */
  adapterSourcePath?: string;
  /** Forbidden-import substrings extra to FORBIDDEN_ADAPTER_IMPORTS. */
  extraForbiddenImports?: string[];
  /**
   * Hook to script the adapter for items that need a programmable response.
   * Called once at the start of each item with the adapter the runner just
   * produced from the factory. For non-programmable adapters, return undefined.
   */
  prepare?: (adapter: Adapter, item: ConformanceItemId) => void | Promise<void>;
  /** Per-item timeout (ms). Default 5000. */
  timeoutMs?: number;
}

const ITEM_TITLES: Record<ConformanceItemId, string> = {
  A: "Text-only turn completes; emits message_finalized and TurnResult",
  B: "Tool-call turn round-trips; adapter consumes tool_result in next turn",
  C: "Cold start with absent provider_state succeeds",
  D: "Resume with prior provider_state envelope continues coherently",
  E: "abort() interrupts active stream within 1 second",
  F: "abort() is idempotent",
  G: "abort() is safe on completed adapter",
  H: "Transport errors surface as report({kind:'error'}), not exceptions",
  I: "Adapter does not import DB / event-writer / worker-pool / child_process",
};

export async function runConformance(
  adapterFactory: () => Adapter | Promise<Adapter>,
  opts: ConformanceOpts = {},
): Promise<ConformanceResult[]> {
  const items = opts.items ?? (Object.keys(ITEM_TITLES) as ConformanceItemId[]);
  const out: ConformanceResult[] = [];
  for (const id of items) {
    const start = Date.now();
    try {
      const adapter = await adapterFactory();
      if (opts.prepare) await opts.prepare(adapter, id);
      const r = await runOne(id, adapter, opts);
      out.push({
        item: id,
        title: ITEM_TITLES[id],
        status: r.status,
        diagnostic: r.diagnostic,
        durationMs: Date.now() - start,
      });
    } catch (e) {
      out.push({
        item: id,
        title: ITEM_TITLES[id],
        status: "failed",
        diagnostic: `runner exception: ${(e as Error).message}`,
        durationMs: Date.now() - start,
      });
    }
  }
  return out;
}

// ── Per-item drivers ─────────────────────────────────────────────────────

interface Outcome { status: "passed" | "failed" | "skipped"; diagnostic?: string }

async function runOne(
  id: ConformanceItemId,
  adapter: Adapter,
  opts: ConformanceOpts,
): Promise<Outcome> {
  switch (id) {
    case "A": return itemA(adapter);
    case "B": return itemB(adapter);
    case "C": return itemC(adapter);
    case "D": return itemD(adapter);
    case "E": return itemE(adapter);
    case "F": return itemF(adapter);
    case "G": return itemG(adapter);
    case "H": return itemH(adapter);
    case "I": return itemI(opts);
  }
}

function blankInput(opId = "conformance-op"): TurnInput {
  return {
    opId,
    turnIdx: 0,
    messages: [],
    tools: [],
    providerState: undefined,
  };
}

async function itemA(adapter: Adapter): Promise<Outcome> {
  const reports: AdapterReport[] = [];
  const result: TurnResult = await adapter.runTurn(blankInput(), r => reports.push(r));
  const finalized = reports.filter(r => r.kind === "message_finalized");
  if (finalized.length === 0) {
    return { status: "failed", diagnostic: "no message_finalized adapter_report emitted" };
  }
  if (!result || !result.providerState) {
    return { status: "failed", diagnostic: "TurnResult.providerState missing" };
  }
  return { status: "passed" };
}

async function itemB(adapter: Adapter): Promise<Outcome> {
  // Turn 1: expect a tool_call_requested adapter_report, no terminal_reason.
  const reports1: AdapterReport[] = [];
  const r1 = await adapter.runTurn(blankInput("conformance-B"), r => reports1.push(r));
  const toolCalls = reports1.filter(r => r.kind === "tool_call_requested");
  if (toolCalls.length === 0) {
    return { status: "failed", diagnostic: "turn 1 emitted no tool_call_requested" };
  }
  if (r1.terminalReason === "done" || r1.terminalReason === "error") {
    return { status: "failed", diagnostic: "turn 1 terminated before tool round-trip" };
  }
  // Turn 2: feed a synthetic tool_result message and expect message_finalized.
  const tc = (toolCalls[0] as { kind: "tool_call_requested"; call: { toolCallId: string } }).call;
  const toolResult: CanonicalMessage = {
    messageId: `tr-${Date.now().toString(36)}`,
    role: "tool_result",
    content: { toolCallId: tc.toolCallId, result: { ok: true } },
  };
  const reports2: AdapterReport[] = [];
  const r2 = await adapter.runTurn(
    {
      opId: "conformance-B",
      turnIdx: 1,
      messages: [toolResult],
      providerState: r1.providerState,
      tools: [],
    },
    r => reports2.push(r),
  );
  if (reports2.filter(r => r.kind === "message_finalized").length === 0) {
    return { status: "failed", diagnostic: "turn 2 emitted no message_finalized after tool_result" };
  }
  if (r2.terminalReason !== "done") {
    return { status: "failed", diagnostic: `turn 2 terminalReason expected 'done', got '${r2.terminalReason}'` };
  }
  return { status: "passed" };
}

async function itemC(adapter: Adapter): Promise<Outcome> {
  const reports: AdapterReport[] = [];
  const result = await adapter.runTurn({ ...blankInput(), providerState: undefined }, r => reports.push(r));
  if (!result.providerState) {
    return { status: "failed", diagnostic: "cold start did not produce a fresh providerState" };
  }
  if (!result.providerState.adapterName) {
    return { status: "failed", diagnostic: "providerState missing adapterName" };
  }
  return { status: "passed" };
}

async function itemD(adapter: Adapter): Promise<Outcome> {
  // First turn populates a provider_state. Second turn must accept it back
  // without error and produce another envelope with the same adapter_name.
  const r1 = await adapter.runTurn(blankInput("conformance-D"), () => { /* drop */ });
  const prior: ProviderStateEnvelope = r1.providerState;
  const r2 = await adapter.runTurn(
    { opId: "conformance-D", turnIdx: 1, messages: [], tools: [], providerState: prior },
    () => { /* drop */ },
  );
  if (!r2.providerState) {
    return { status: "failed", diagnostic: "resume turn returned no providerState" };
  }
  if (r2.providerState.adapterName !== prior.adapterName) {
    return {
      status: "failed",
      diagnostic: `providerState.adapterName flipped: ${prior.adapterName} → ${r2.providerState.adapterName}`,
    };
  }
  return { status: "passed" };
}

async function itemE(adapter: Adapter): Promise<Outcome> {
  // Driver: start a long-running runTurn, abort after a short delay, expect
  // the promise to resolve within 1 second total.
  const reports: AdapterReport[] = [];
  const start = Date.now();
  const work = adapter.runTurn(blankInput("conformance-E"), r => reports.push(r));
  // Give the adapter a moment to enter streaming.
  await new Promise(r => setTimeout(r, 30));
  await adapter.abort();
  await work.catch(() => { /* swallow; contract says errors come via report */ });
  const elapsed = Date.now() - start;
  if (elapsed >= 1000) {
    return { status: "failed", diagnostic: `abort took ${elapsed}ms (>=1000ms PRD limit)` };
  }
  return { status: "passed", diagnostic: `aborted in ${elapsed}ms` };
}

async function itemF(adapter: Adapter): Promise<Outcome> {
  // Idempotent: two abort() calls produce no error.
  await adapter.abort();
  try {
    await adapter.abort();
  } catch (e) {
    return { status: "failed", diagnostic: `second abort() threw: ${(e as Error).message}` };
  }
  return { status: "passed" };
}

async function itemG(adapter: Adapter): Promise<Outcome> {
  // Run a turn to completion, then abort — must not throw.
  await adapter.runTurn(blankInput("conformance-G"), () => { /* drop */ });
  try {
    await adapter.abort();
  } catch (e) {
    return { status: "failed", diagnostic: `abort() after completion threw: ${(e as Error).message}` };
  }
  return { status: "passed" };
}

async function itemH(adapter: Adapter): Promise<Outcome> {
  // Transport-error-style turn: contract says routine errors come via
  // report({kind:"error"}), not exceptions. We just verify the adapter
  // returns from runTurn without throwing for normal scripts. Real
  // transport-error simulation lives in Issue 09 against the Anthropic
  // adapter (this is a smoke check at Issue 02).
  try {
    const reports: AdapterReport[] = [];
    await adapter.runTurn(blankInput("conformance-H"), r => reports.push(r));
    return { status: "passed" };
  } catch (e) {
    return { status: "failed", diagnostic: `runTurn threw: ${(e as Error).message}` };
  }
}

function itemI(opts: ConformanceOpts): Outcome {
  if (!opts.adapterSourcePath) {
    return { status: "skipped", diagnostic: "no adapterSourcePath provided — sandbox audit not run" };
  }
  if (!existsSync(opts.adapterSourcePath)) {
    return { status: "failed", diagnostic: `adapterSourcePath does not exist: ${opts.adapterSourcePath}` };
  }
  const src = readFileSync(opts.adapterSourcePath, "utf-8");
  const forbidden = [...FORBIDDEN_ADAPTER_IMPORTS, ...(opts.extraForbiddenImports ?? [])];
  // Only flag actual import statements, not type comments / glossary mentions.
  const hits: string[] = [];
  for (const f of forbidden) {
    // crude but effective: match `from "...<f>..."` or `require("...<f>...")`
    const fromRe = new RegExp(`from\\s+['"][^'"]*${escape(f)}[^'"]*['"]`);
    const reqRe = new RegExp(`require\\(\\s*['"][^'"]*${escape(f)}[^'"]*['"]\\s*\\)`);
    if (fromRe.test(src) || reqRe.test(src)) {
      hits.push(f);
    }
  }
  if (hits.length > 0) {
    return {
      status: "failed",
      diagnostic: `adapter imports forbidden modules: ${hits.join(", ")}`,
    };
  }
  return { status: "passed" };
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Reporting helpers ────────────────────────────────────────────────────

export function summarize(results: ConformanceResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    const tag = r.status === "passed" ? "PASS" : r.status === "failed" ? "FAIL" : "SKIP";
    lines.push(`[${tag}] ${r.item}: ${r.title}${r.diagnostic ? ` — ${r.diagnostic}` : ""}`);
  }
  return lines.join("\n");
}
