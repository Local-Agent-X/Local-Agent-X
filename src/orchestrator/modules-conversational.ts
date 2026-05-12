import { EmotionalMemory } from "../emotional-memory.js";
import { ProactiveMemory } from "../proactive-memory.js";
import { NarrativeMemory } from "../narrative-memory.js";
import { InsideReferences } from "../inside-references.js";
import { AnticipatoryCare } from "../anticipatory-care.js";
import { SharedHistory } from "../shared-history.js";
import { LanguageMirror } from "../language-mirror.js";
import { TrustEngine } from "../trust-deepening.js";
import { VulnerabilityAwareness } from "../vulnerability-awareness.js";
import { AssociativeMemory } from "../associative-recall.js";
import type { OrchestratorInput, ModuleSignal } from "./types.js";

export function runConversationalModule(name: string, input: OrchestratorInput, signals: ModuleSignal[]): boolean {
  switch (name) {
    case "emotional-memory": {
      const emotion = EmotionalMemory.detectEmotion(input.message);
      if (emotion.confidence > 0.3) {
        const hint = EmotionalMemory.getAdaptationHint(emotion);
        signals.push({
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
          signals.push({
            source: "emotional-memory",
            signal: `Emotional shift detected: moved from ${prev} to ${curr}`,
            priority: 7,
            category: "emotion-shift",
            confidence: 1.0,
          });
        }
      }
      return true;
    }

    case "language-mirror": {
      const mirror = LanguageMirror.getInstance();
      const profile = mirror.getStyleProfile();
      if (profile.sampleSize > 3) {
        const hint = mirror.getStyleHint();
        if (hint) {
          signals.push({
            source: "language-mirror",
            signal: hint,
            priority: 4,
            category: "style",
            confidence: 1.0,
          });
        }
      }
      return true;
    }

    case "trust-engine": {
      const trust = TrustEngine.getInstance();
      const stage = trust.getRelationshipStage();
      const adjustments = trust.getBehaviorAdjustments();
      signals.push({
        source: "trust-engine",
        signal: stage,
        priority: 3,
        category: "trust",
        confidence: 1.0,
      });
      if (adjustments.personalReferences) {
        signals.push({
          source: "trust-engine",
          signal: "Relationship is close enough for personal references and callbacks to shared history",
          priority: 2,
          category: "trust-behavior",
          confidence: 1.0,
        });
      }
      return true;
    }

    case "inside-references": {
      const refs = InsideReferences.getInstance();
      const callback = refs.detectCallback(input.message);
      if (callback) {
        signals.push({
          source: "inside-references",
          signal: `Possible inside reference: "${callback.reference}" — ${callback.originalContext}`,
          priority: 8,
          category: "reference",
          confidence: 1.0,
        });
      }
      return true;
    }

    case "anticipatory-care": {
      const care = AnticipatoryCare.getInstance();
      const followUps = care.getFollowUps();
      for (const fu of followUps.slice(0, 2)) {
        signals.push({
          source: "anticipatory-care",
          signal: `Follow up on "${fu.event.event}": ${fu.suggestedMessage}`,
          priority: 6,
          category: "followup",
          confidence: 1.0,
        });
      }
      const proactive = care.getProactiveMessage(input.timeOfDay);
      if (proactive) {
        signals.push({
          source: "anticipatory-care",
          signal: proactive,
          priority: 5,
          category: "proactive",
          confidence: 1.0,
        });
      }
      return true;
    }

    case "vulnerability-awareness": {
      const vuln = VulnerabilityAwareness.getInstance();
      const share = vuln.detectVulnerability(input.message);
      if (share) {
        const guidance = vuln.getHandlingGuidance(share.category);
        signals.push({
          source: "vulnerability-awareness",
          signal: guidance,
          priority: 9,
          category: "vulnerability",
          confidence: 1.0,
        });
      }
      return true;
    }

    case "associative-recall": {
      const assoc = AssociativeMemory.getInstance();
      const results = assoc.recall(input.message);
      if (results.length > 0) {
        const top = results[0];
        signals.push({
          source: "associative-recall",
          signal: `Related memory: ${top.content} (relevance: ${top.score.toFixed(2)})`,
          priority: 4 + Math.round(top.score * 3),
          category: "recall",
          confidence: 1.0,
        });
      }
      return true;
    }

    case "proactive-memory": {
      const pm = ProactiveMemory;
      const suggestions = pm.analyzeContext(
        input.message,
        input.sessionMessages,
        input.timeOfDay,
      );
      if (suggestions && suggestions.length > 0) {
        const top = suggestions.sort((a, b) => b.confidence - a.confidence)[0];
        signals.push({
          source: "proactive-memory",
          signal: top.message,
          priority: 3 + Math.round(top.confidence * 4),
          category: "proactive",
          confidence: 1.0,
        });
      }
      return true;
    }

    case "shared-history": {
      const sh = SharedHistory.getInstance();
      const summary = sh.getRelationshipSummary();
      if (summary.totalConversations > 5) {
        const moments = sh.getMostMemorableMoments(3);
        if (moments.length > 0) {
          signals.push({
            source: "shared-history",
            signal: `Notable shared moments: ${moments.map(m => m.description).join("; ")}`,
            priority: 2,
            category: "history",
            confidence: 1.0,
          });
        }
      }
      return true;
    }

    case "narrative-memory": {
      const nm = NarrativeMemory.getInstance();
      const detected = nm.autoDetectNarrative(input.sessionMessages);
      if (detected) {
        signals.push({
          source: "narrative-memory",
          signal: `Ongoing story: "${detected.title}" — ${detected.summary}`,
          priority: 4,
          category: "narrative",
          confidence: 1.0,
        });
      }
      const ongoing = nm.getOngoingStories();
      if (ongoing.length > 0 && !detected) {
        signals.push({
          source: "narrative-memory",
          signal: `Continuing narrative: "${ongoing[0].title}"`,
          priority: 3,
          category: "narrative",
          confidence: 1.0,
        });
      }
      return true;
    }
  }
  return false;
}
