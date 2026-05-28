import { EmotionalMemory } from "../emotional-memory.js";
import { MemoryGraph } from "../memory-graph.js";
import { ProactiveMemory } from "../proactive-memory/index.js";
import MemoryImportance from "../memory-importance/index.js";
import { SharedHistory } from "../shared-history.js";
import { LanguageMirror } from "../language-mirror.js";
import { TrustEngine } from "../trust-deepening.js";
import { VulnerabilityAwareness } from "../vulnerability-awareness.js";
import { CorrectionLearner } from "../correction-learning.js";
import { AssociativeMemory } from "../associative-recall/index.js";
import { PredictivePrefetcher } from "../predictive-prefetch.js";
import type { OrchestratorInput, ModuleSignal, Notification } from "./types.js";
import { GRAPH_STOP_WORDS } from "./types.js";
import { safeRun } from "./state.js";

export function extractNotifications(signals: ModuleSignal[], input: OrchestratorInput): Notification[] {
  const notifications: Notification[] = [];

  for (const sig of signals) {
    if (sig.category === "milestone") {
      notifications.push({
        type: "celebration",
        message: sig.signal,
        priority: sig.priority,
      });
    }
    if (sig.category === "followup") {
      notifications.push({
        type: "followup",
        message: sig.signal,
        priority: sig.priority,
      });
    }
    if (sig.category === "growth" && sig.priority >= 5) {
      notifications.push({
        type: "insight",
        message: sig.signal,
        priority: sig.priority,
      });
    }
    if (sig.category === "unspoken") {
      notifications.push({
        type: "insight",
        message: sig.signal,
        priority: sig.priority,
      });
    }
  }

  return notifications.sort((a, b) => b.priority - a.priority).slice(0, 3);
}

export function recordFromMessage(input: OrchestratorInput): void {
  safeRun("emotional-memory:record", () => {
    const emotion = EmotionalMemory.detectEmotion(input.message);
    if (emotion.confidence > 0.2) {
      EmotionalMemory.recordEmotion(input.sessionId, emotion, input.message.slice(0, 100));
    }
  }, undefined);

  safeRun("language-mirror:record", () => {
    LanguageMirror.getInstance().recordUserStyle(input.message);
  }, undefined);

  safeRun("trust-engine:record", () => {
    const trust = TrustEngine.getInstance();
    const emotion = EmotionalMemory.detectEmotion(input.message);
    if (emotion.primary === "happy" || emotion.primary === "grateful" || emotion.primary === "excited") {
      trust.recordPositiveSignal("praise");
    }
    if (emotion.primary === "frustrated" || emotion.primary === "angry") {
      trust.recordNegativeSignal("frustration");
    }
  }, undefined);

  safeRun("shared-history:record", () => {
    if (input.message.length > 100) {
      SharedHistory.getInstance().recordMoment({
        description: input.message.slice(0, 200),
        timestamp: Date.now(),
        sessionId: input.sessionId,
        significance: 3,
      });
    }
  }, undefined);

  safeRun("proactive-memory:record", () => {
    ProactiveMemory.recordInteraction(input.sessionId, input.message, Date.now());
  }, undefined);

  safeRun("vulnerability-awareness:record", () => {
    const vuln = VulnerabilityAwareness.getInstance();
    const share = vuln.detectVulnerability(input.message);
    if (share) {
      vuln.recordVulnerableShare(share);
    }
  }, undefined);

  safeRun("correction-learning:record", () => {
    if (input.agentPreviousMessage) {
      const cl = CorrectionLearner.getInstance();
      const correction = cl.detectCorrection(input.message, input.agentPreviousMessage);
      if (correction) {
        cl.recordCorrection(correction);
      }
    }
  }, undefined);

  safeRun("predictive-prefetch:record", () => {
    const words = input.message.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    PredictivePrefetcher.getInstance().learnSchedule(Date.now(), words.slice(0, 10), []);
  }, undefined);

  safeRun("associative-recall:record", () => {
    const words = input.message.split(/\s+/).filter(w => w.length > 5);
    if (words.length >= 2) {
      const assoc = AssociativeMemory.getInstance();
      assoc.learnAssociation(words[0], words[1], "co-occurrence", 0.3);
    }
  }, undefined);

  safeRun("memory-graph:record", () => {
    if (input.message.length < 40) return;
    const entityCandidates = [...new Set(
      (input.message.match(/\b[A-Z][a-zA-Z]{2,}\b/g) || [])
        .filter(w => !GRAPH_STOP_WORDS.has(w.toLowerCase()))
    )];
    if (entityCandidates.length < 2) return;
    const extracted = MemoryGraph.autoExtractRelationships(input.message, entityCandidates);
    for (const edge of extracted) {
      MemoryGraph.addEdge(edge.from, edge.relation, edge.to, edge.metadata);
    }
  }, undefined);

  safeRun("memory-importance:record", () => {
    if (input.message.length > 30) {
      MemoryImportance.scoreMemory({ content: input.message, createdAt: Date.now() });
    }
  }, undefined);
}
