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
    scope: "profile",
    critical: true,
    triage: () => "always",
    run(input, out) {
      const emotion = EmotionalMemory.detectEmotion(input.message);
      if (emotion.confidence > 0.3) {
        const hint = EmotionalMemory.getAdaptationHint(emotion);
        out.push({
          source: "emotional-memory",
          signal: hint,
          priority: 5 + Math.round(emotion.confidence * 3),
          category: "emotion",
          confidence: 1.0,
        });
      }
      const history = EmotionalMemory.getEmotionalHistory(input.sessionId, 5);
      if (history.length >= 2) {
        const prev = history[history.length - 1].emotion.primary;
        const curr = emotion.primary;
        if (prev !== curr && emotion.confidence > 0.5) {
          out.push({
            source: "emotional-memory",
            signal: `Emotional shift detected: moved from ${prev} to ${curr}`,
            priority: 7,
            category: "emotion-shift",
            confidence: 1.0,
          });
        }
      }
    },
    record(input) {
      const emotion = EmotionalMemory.detectEmotion(input.message);
      if (emotion.confidence > 0.2) {
        EmotionalMemory.recordEmotion(input.sessionId, emotion, input.message.slice(0, 100));
      }
    },
    health: () => EmotionalMemory,
  },

  {
    id: "language-mirror",
    scope: "profile",
    triage: () => "always",
    run(_input, out) {
      const mirror = LanguageMirror.getInstance();
      const profile = mirror.getStyleProfile();
      if (profile.sampleSize > 3) {
        const hint = mirror.getStyleHint();
        if (hint) {
          out.push({
            source: "language-mirror",
            signal: hint,
            priority: 4,
            category: "style",
            confidence: 1.0,
          });
        }
      }
    },
    record(input) {
      LanguageMirror.getInstance().recordUserStyle(input.message);
    },
    health: () => LanguageMirror.getInstance(),
  },

  {
    id: "trust-engine",
    scope: "profile",
    triage: () => "always",
    run(_input, out) {
      const trust = TrustEngine.getInstance();
      const stage = trust.getRelationshipStage();
      const adjustments = trust.getBehaviorAdjustments();
      out.push({
        source: "trust-engine",
        signal: stage,
        priority: 3,
        category: "trust",
        confidence: 1.0,
      });
      if (adjustments.personalReferences) {
        out.push({
          source: "trust-engine",
          signal: "Relationship is close enough for personal references and callbacks to shared history",
          priority: 2,
          category: "trust-behavior",
          confidence: 1.0,
        });
      }
    },
    record(input) {
      const trust = TrustEngine.getInstance();
      const emotion = EmotionalMemory.detectEmotion(input.message);
      if (emotion.primary === "happy" || emotion.primary === "grateful" || emotion.primary === "excited") {
        trust.recordPositiveSignal("praise");
      }
      if (emotion.primary === "frustrated" || emotion.primary === "angry") {
        trust.recordNegativeSignal("frustration");
      }
    },
    health: () => TrustEngine.getInstance(),
  },

  {
    id: "inside-references",
    scope: "session",
    triage: ({ input }) =>
      input.message.length < 60 || /^(that|this|the one|you know|it|same)\b/i.test(input.message)
        ? "conditional"
        : null,
    run(input, out) {
      const refs = InsideReferences.getInstance();
      const callback = refs.detectCallback(input.message);
      if (callback) {
        out.push({
          source: "inside-references",
          signal: `Possible inside reference: "${callback.reference}" — ${callback.originalContext}`,
          priority: 8,
          category: "reference",
          confidence: 1.0,
        });
      }
    },
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
    run(input, out) {
      const care = AnticipatoryCare.getInstance();
      const followUps = care.getFollowUps();
      for (const fu of followUps.slice(0, 2)) {
        out.push({
          source: "anticipatory-care",
          signal: `Follow up on "${fu.event.event}": ${fu.suggestedMessage}`,
          priority: 6,
          category: "followup",
          confidence: 1.0,
        });
      }
      const proactive = care.getProactiveMessage(input.timeOfDay);
      if (proactive) {
        out.push({
          source: "anticipatory-care",
          signal: proactive,
          priority: 5,
          category: "proactive",
          confidence: 1.0,
        });
      }
    },
    health: () => AnticipatoryCare.getInstance(),
  },

  {
    id: "vulnerability-awareness",
    scope: "profile",
    critical: true,
    triage: ({ input }) =>
      SENSITIVE_KEYWORDS.some(kw => input.message.toLowerCase().includes(kw)) ? "conditional" : null,
    run(input, out) {
      const vuln = VulnerabilityAwareness.getInstance();
      const share = vuln.detectVulnerability(input.message);
      if (share) {
        const guidance = vuln.getHandlingGuidance(share.category);
        out.push({
          source: "vulnerability-awareness",
          signal: guidance,
          priority: 9,
          category: "vulnerability",
          confidence: 1.0,
        });
      }
    },
    record(input) {
      const vuln = VulnerabilityAwareness.getInstance();
      const share = vuln.detectVulnerability(input.message);
      if (share) {
        vuln.recordVulnerableShare(share);
      }
    },
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
    run(input, out) {
      const assoc = AssociativeMemory.getInstance();
      const results = assoc.recall(input.message);
      if (results.length > 0) {
        const top = results[0];
        out.push({
          source: "associative-recall",
          signal: `Related memory: ${top.content} (relevance: ${top.score.toFixed(2)})`,
          priority: 4 + Math.round(top.score * 3),
          category: "recall",
          confidence: 1.0,
        });
      }
    },
    record(input) {
      const words = input.message.split(/\s+/).filter(w => w.length > 5);
      if (words.length >= 2) {
        AssociativeMemory.getInstance().learnAssociation(words[0], words[1], "co-occurrence", 0.3);
      }
    },
    health: () => AssociativeMemory.getInstance(),
  },

  {
    id: "proactive-memory",
    scope: "profile",
    triage: () => "conditional",
    run(input, out) {
      const suggestions = ProactiveMemory.analyzeContext(
        input.message,
        input.sessionMessages,
        input.timeOfDay,
      );
      if (suggestions && suggestions.length > 0) {
        const top = suggestions.sort((a, b) => b.confidence - a.confidence)[0];
        out.push({
          source: "proactive-memory",
          signal: top.message,
          priority: 3 + Math.round(top.confidence * 4),
          category: "proactive",
          confidence: 1.0,
        });
      }
    },
    record(input) {
      ProactiveMemory.recordInteraction(input.sessionId, input.message, Date.now());
    },
    health: () => ProactiveMemory,
  },

  {
    id: "shared-history",
    scope: "profile",
    triage: () => "conditional",
    run(_input, out) {
      const sh = SharedHistory.getInstance();
      const summary = sh.getRelationshipSummary();
      if (summary.totalConversations > 5) {
        const moments = sh.getMostMemorableMoments(3);
        if (moments.length > 0) {
          out.push({
            source: "shared-history",
            signal: `Notable shared moments: ${moments.map(m => m.description).join("; ")}`,
            priority: 2,
            category: "history",
            confidence: 1.0,
          });
        }
      }
    },
    record(input) {
      if (input.message.length > 100) {
        SharedHistory.getInstance().recordMoment({
          description: input.message.slice(0, 200),
          timestamp: Date.now(),
          sessionId: input.sessionId,
          significance: 3,
        });
      }
    },
    health: () => SharedHistory.getInstance(),
  },

  {
    id: "narrative-memory",
    scope: "session",
    triage: ({ input }) => (STORY_PATTERNS.some(p => p.test(input.message)) ? "scheduled" : null),
    run(input, out) {
      const nm = NarrativeMemory.getInstance();
      const detected = nm.autoDetectNarrative(input.sessionMessages);
      if (detected) {
        out.push({
          source: "narrative-memory",
          signal: `Ongoing story: "${detected.title}" — ${detected.summary}`,
          priority: 4,
          category: "narrative",
          confidence: 1.0,
        });
      }
      const ongoing = nm.getOngoingStories();
      if (ongoing.length > 0 && !detected) {
        out.push({
          source: "narrative-memory",
          signal: `Continuing narrative: "${ongoing[0].title}"`,
          priority: 3,
          category: "narrative",
          confidence: 1.0,
        });
      }
    },
    health: () => NarrativeMemory.getInstance(),
  },
];
