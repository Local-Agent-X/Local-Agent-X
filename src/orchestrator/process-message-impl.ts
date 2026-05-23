import type {
  OrchestratorInput,
  OrchestratorOutput,
  DebugInfo,
} from "./types.js";
import { orchestratorState, safeRun, saveState } from "./state.js";
import { saveExample, autoRateLastExample } from "./storage.js";
import { triageModules } from "./triage.js";
import { gatherSignals } from "./modules.js";
import { applyVetoLayer, calculateFusionConfidence, checkDeepPassNeeded } from "./fusion.js";
import { mergeSignals } from "./signals.js";
import { extractNotifications, recordFromMessage } from "./notifications.js";
import { buildAdaptations } from "./adaptations.js";
import { applyBleedGate, classifyVerdict, getAnchorText } from "./bleed-gate.js";

export async function processMessageImpl(input: OrchestratorInput): Promise<OrchestratorOutput> {
  const startTime = Date.now();
  orchestratorState.messageCount++;

  safeRun("auto-rate", () => autoRateLastExample(input.message), undefined);

  const triage = triageModules(input, orchestratorState.messageCount);
  const allActivated = [...triage.always, ...triage.conditional, ...triage.scheduled, ...triage.triggered];

  let signals = gatherSignals(input, triage);

  const veto = applyVetoLayer(signals);
  if (veto.vetoed && veto.overrideSignal) {
    signals = signals.filter(s => s.source !== veto.overrideSignal!.source);
    signals.unshift(veto.overrideSignal);
  }

  const deepPass = checkDeepPassNeeded(signals, allActivated);
  if (deepPass.needed) {
    for (const mod of deepPass.modules) {
      const deepSignal = safeRun(mod + "-deep", () => {
        const expandedInput = { ...input, sessionMessages: input.sessionMessages.slice(-40) };
        return gatherSignals(expandedInput, { always: [mod], conditional: [], scheduled: [], triggered: [] });
      }, []);
      if (deepSignal.length > 0) {
        signals = signals.filter(s => s.source !== mod);
        signals.push(...deepSignal);
      }
    }
  }

  // Cross-conversation bleed guard, structural version. Each module is
  // tagged with its scope in MODULE_SCOPE (orchestrator/types.ts):
  //   - "profile" modules describe the user as a stable entity
  //     (emotion, style, trust, growth, milestones, etc.) → always pass.
  //   - "session" modules pull content that could have originated in a
  //     different conversation (callbacks, recall, ongoing narratives,
  //     followups about past topics) → must clear an additional gate:
  //     short follow-ups drop them entirely; substantive messages
  //     require 2+ topical-keyword overlap with the user's input.
  //
  // Why scope, not category: the prior heuristic used a HIGH_BLEED
  // category set ("recall", "narrative", etc.) which caught some leaks
  // but also gated profile-emitting modules whose category happened to
  // overlap. Scoping at the module boundary is the structural fix —
  // the audit recommendation #3.
  const anchorText = getAnchorText(input);
  const verdict = await classifyVerdict(input, anchorText);
  const beforeCount = signals.length;
  signals = await applyBleedGate(signals, verdict, input, anchorText);

  if (beforeCount !== signals.length) {
    const dropped = beforeCount - signals.length;
    const reason = verdict === "followup" ? "follow-up" : verdict === "resume" ? "resume-gate" : "topical-gate";
    // eslint-disable-next-line no-console
    console.info(`[orchestrator] bleed gate (${reason}) dropped ${dropped} signals (msg="${input.message.slice(0, 40)}")`);
  }

  const merged = mergeSignals(signals, orchestratorState.lastSignalHashes, { sessionId: input.sessionId });

  const fusionConfidence = calculateFusionConfidence(merged.usedSignals);

  const notifications = extractNotifications(signals, input);

  const adaptations = buildAdaptations(signals);

  const debug: DebugInfo = {
    modulesActivated: allActivated,
    totalTimeMs: Date.now() - startTime,
    signals: Object.fromEntries(signals.map(s => [s.source + ":" + s.category, {
      signal: s.signal.slice(0, 80),
      priority: s.priority,
      confidence: s.confidence,
    }])),
    fusionConfidence,
    vetoApplied: veto.vetoed,
    vetoReason: veto.reason,
    deepPassTriggered: deepPass.needed,
    deepPassModules: deepPass.modules,
  } as any;

  const output: OrchestratorOutput = {
    contextInjection: merged.paragraph,
    adaptations,
    notifications,
    debug,
  };

  safeRun("recording", () => recordFromMessage(input), undefined);

  safeRun("save-example", () => {
    saveExample({
      input: { message: input.message.slice(0, 200), timeOfDay: input.timeOfDay },
      modulesActivated: allActivated,
      signals: merged.usedSignals.map(s => ({ ...s, signal: s.signal.slice(0, 100) })),
      output: merged.paragraph.slice(0, 300),
      quality: "neutral",
      timestamp: Date.now(),
    });
  }, undefined);

  orchestratorState.lastProcessedAt = Date.now();
  orchestratorState.lastSignalHashes = merged.hashes;
  saveState(orchestratorState);

  return output;
}
