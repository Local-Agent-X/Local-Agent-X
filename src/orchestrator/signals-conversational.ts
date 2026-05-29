import { EmotionalMemory } from "../emotional-memory.js";
import { ProactiveMemory } from "../memory/cognitive/proactive/index.js";
import { NarrativeMemory } from "../narrative-memory.js";
import { InsideReferences } from "../inside-references.js";
import { AnticipatoryCare } from "../anticipatory-care/index.js";
import { SharedHistory } from "../shared-history.js";
import { LanguageMirror } from "../language-mirror.js";
import { TrustEngine } from "../trust-deepening.js";
import { VulnerabilityAwareness } from "../vulnerability-awareness.js";
import { AssociativeMemory } from "../associative-recall/index.js";
import type { CognitiveSignal } from "./types.js";
import { SENSITIVE_KEYWORDS, STORY_PATTERNS } from "./types.js";

export const conversationalSignals: CognitiveSignal[] = [
  {
    id: "emotional-memory",
    storageFile: "emotional-history.json",
    scope: "profile",
    critical: true,
    triage: () => "always",
    run: (input, out) => out.push(...EmotionalMemory.signalsFor(input.message, input.sessionId)),
    record: input => EmotionalMemory.recordFrom(input.message, input.sessionId),
    health: () => EmotionalMemory,
  },

  {
    id: "language-mirror",
    storageFile: "language-style.json",
    scope: "profile",
    triage: () => "always",
    run: (_input, out) => out.push(...LanguageMirror.getInstance().signalsFor()),
    record: input => LanguageMirror.getInstance().recordFrom(input.message),
    health: () => LanguageMirror.getInstance(),
  },

  {
    id: "trust-engine",
    storageFile: "trust-engine.json",
    scope: "profile",
    triage: () => "always",
    run: (_input, out) => out.push(...TrustEngine.getInstance().signalsFor()),
    record: input => TrustEngine.getInstance().recordFrom(input.message),
    health: () => TrustEngine.getInstance(),
  },

  {
    id: "inside-references",
    storageFile: "inside-references.json",
    scope: "session",
    triage: ({ input }) =>
      input.message.length < 60 || /^(that|this|the one|you know|it|same)\b/i.test(input.message)
        ? "conditional"
        : null,
    run: (input, out) => out.push(...InsideReferences.getInstance().signalsFor(input.message)),
    health: () => InsideReferences.getInstance(),
  },

  {
    id: "anticipatory-care",
    scope: "session",
    triage: ({ input }) => {
      const care = AnticipatoryCare.getInstance();
      if (care.getFollowUps().length > 0) return "conditional";
      if (care.getProactiveMessage(input.timeOfDay)) return "conditional";
      return null;
    },
    run: (input, out) => out.push(...AnticipatoryCare.getInstance().signalsFor(input.timeOfDay)),
    health: () => AnticipatoryCare.getInstance(),
  },

  {
    id: "vulnerability-awareness",
    storageFile: "vulnerability-shares.json",
    scope: "profile",
    critical: true,
    triage: ({ input }) =>
      SENSITIVE_KEYWORDS.some(kw => input.message.toLowerCase().includes(kw)) ? "conditional" : null,
    run: (input, out) => out.push(...VulnerabilityAwareness.getInstance().signalsFor(input.message)),
    record: input => VulnerabilityAwareness.getInstance().recordFrom(input.message),
    veto: sig =>
      sig.priority >= 8
        ? {
            reason: "Sacred/vulnerable topic detected — overriding normal tone",
            overrideSignal: { ...sig, priority: 10, confidence: 1.0 },
          }
        : null,
    health: () => VulnerabilityAwareness.getInstance(),
  },

  {
    id: "associative-recall",
    scope: "session",
    triage: ({ input }) => (input.message.length > 30 ? "conditional" : null),
    run: (input, out) => out.push(...AssociativeMemory.getInstance().signalsFor(input.message)),
    record: input => AssociativeMemory.getInstance().recordFrom(input.message),
    health: () => AssociativeMemory.getInstance(),
  },

  {
    id: "proactive-memory",
    scope: "profile",
    triage: () => "conditional",
    run: (input, out) => out.push(...ProactiveMemory.signalsFor(input.message, input.sessionMessages, input.timeOfDay)),
    record: input => ProactiveMemory.recordFrom(input.sessionId, input.message),
    health: () => ProactiveMemory,
  },

  {
    id: "shared-history",
    storageFile: "shared-history.json",
    scope: "profile",
    triage: () => "conditional",
    run: (_input, out) => out.push(...SharedHistory.getInstance().signalsFor()),
    record: input => SharedHistory.getInstance().recordFrom(input.message, input.sessionId),
    health: () => SharedHistory.getInstance(),
  },

  {
    id: "narrative-memory",
    storageFile: "narratives.json",
    scope: "session",
    triage: ({ input }) => (STORY_PATTERNS.some(p => p.test(input.message)) ? "scheduled" : null),
    run: (input, out) => out.push(...NarrativeMemory.getInstance().signalsFor(input.sessionMessages)),
    health: () => NarrativeMemory.getInstance(),
  },
];
