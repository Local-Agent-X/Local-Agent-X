/**
 * Memory Orchestrator — the single coordination brain for all memory modules.
 *
 * This is the ONLY module the server needs to call. It triages which modules
 * to activate, gathers their signals in parallel, merges them into a single
 * coherent context injection, extracts notifications, and records new data.
 *
 * Persists orchestrator metadata to ~/.sax/orchestrator-state.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

// ── Module imports ──────────────────────────────────────────

import { EmotionalMemory } from "./emotional-memory.js";
import { MemoryGraph } from "./memory-graph.js";
import { ProactiveMemory } from "./proactive-memory.js";
import MemoryImportance from "./memory-importance.js";
import crossSessionLearner, { CrossSessionLearner as CrossSessionLearnerClass } from "./cross-session-learning.js";
import { NarrativeMemory } from "./narrative-memory.js";
import { UnspokenDetector } from "./unspoken-detector.js";
import { InsideReferences } from "./inside-references.js";
import { GrowthTracker } from "./growth-tracker.js";
import { AnticipatoryCare } from "./anticipatory-care.js";
import { SharedHistory } from "./shared-history.js";
import { LanguageMirror } from "./language-mirror.js";
import { TrustEngine } from "./trust-deepening.js";
import { MilestoneCelebrator } from "./milestone-celebrations.js";
import { VulnerabilityAwareness } from "./vulnerability-awareness.js";
import { CorrectionLearner } from "./correction-learning.js";
import { MemoryTierManager } from "./memory-tiers.js";
import { ContradictionDetector } from "./contradiction-detector.js";
import { AssociativeMemory } from "./associative-recall.js";
import { PredictivePrefetcher } from "./predictive-prefetch.js";
import { MemoryCompressor } from "./memory-compression.js";
import { MemoryConsolidator } from "./memory-consolidation.js";

// ── Types ────────────────────────────────────────────────────

export interface OrchestratorInput {
  message: string;
  sessionId: string;
  sessionMessages: { role: string; content: string }[];
  timeOfDay: number;   // 0-23
  dayOfWeek: number;   // 0-6
  agentPreviousMessage?: string;
}

export interface Adaptation {
  type: string;
  instruction: string;
  priority: number;
}

export interface Notification {
  type: "milestone" | "followup" | "insight" | "celebration";
  message: string;
  priority: number;
}

export interface DebugInfo {
  modulesActivated: string[];
  totalTimeMs: number;
  signals: Record<string, unknown>;
}

export interface OrchestratorOutput {
  contextInjection: string;
  adaptations: Adaptation[];
  notifications: Notification[];
  debug: DebugInfo;
}

interface ModuleSignal {
  source: string;
  signal: string;
  priority: number;  // 0-10
  category: string;
  confidence: number; // 0-1, how confident the module is in this signal
}

// ── Fusion Confidence + Veto Layer ──────────────────────────

interface FusionResult {
  signals: ModuleSignal[];
  fusionConfidence: number;    // 0-1, overall confidence in merged output
  vetoApplied: boolean;        // true if a sacred/vulnerability signal overrode normal flow
  vetoReason?: string;
  deepPassTriggered: boolean;  // true if low confidence triggered a deeper analysis
}

/** Sacred topics and high-vulnerability signals break through even if heuristics keep things light */
function applyVetoLayer(signals: ModuleSignal[]): { vetoed: boolean; reason?: string; overrideSignal?: ModuleSignal } {
  // Check for vulnerability/sacred signals — these ALWAYS take priority
  for (const sig of signals) {
    if (sig.source === "vulnerability-awareness" && sig.priority >= 8) {
      return {
        vetoed: true,
        reason: "Sacred/vulnerable topic detected — overriding normal tone",
        overrideSignal: { ...sig, priority: 10, confidence: 1.0 },
      };
    }
    if (sig.source === "contradiction-detector" && sig.confidence >= 0.8) {
      return {
        vetoed: true,
        reason: "High-confidence contradiction — must address before proceeding",
        overrideSignal: { ...sig, priority: 9, confidence: 1.0 },
      };
    }
    if (sig.source === "correction-learning" && sig.confidence >= 0.7) {
      return {
        vetoed: true,
        reason: "User correction detected — acknowledge and fix",
        overrideSignal: { ...sig, priority: 9, confidence: 1.0 },
      };
    }
  }
  return { vetoed: false };
}

/** Calculate overall fusion confidence from individual module confidences */
function calculateFusionConfidence(signals: ModuleSignal[]): number {
  if (signals.length === 0) return 0;
  // Weighted average: higher priority signals contribute more to overall confidence
  let totalWeight = 0;
  let weightedSum = 0;
  for (const sig of signals) {
    const weight = sig.priority;
    totalWeight += weight;
    weightedSum += sig.confidence * weight;
  }
  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

/** If critical modules have low confidence, identify which ones need a deeper pass */
function checkDeepPassNeeded(signals: ModuleSignal[], activatedModules: string[]): { needed: boolean; modules: string[] } {
  const criticalModules = ["vulnerability-awareness", "contradiction-detector", "correction-learning", "emotional-memory"];
  const lowConfidence: string[] = [];
  for (const sig of signals) {
    if (criticalModules.includes(sig.source) && sig.confidence < 0.4 && sig.confidence > 0.1) {
      lowConfidence.push(sig.source);
    }
  }
  // Also check if critical modules were activated but produced no signal (suspicious)
  for (const mod of activatedModules) {
    if (criticalModules.includes(mod) && !signals.some(s => s.source === mod)) {
      lowConfidence.push(mod);
    }
  }
  return { needed: lowConfidence.length > 0, modules: [...new Set(lowConfidence)] };
}

// ── Orchestration Examples (for tuning) ─────────────────────

interface OrchestrationExample {
  input: { message: string; timeOfDay: number };
  modulesActivated: string[];
  signals: ModuleSignal[];
  output: string;
  quality: "good" | "bad" | "neutral";
  timestamp: number;
  notes?: string;
}

const EXAMPLES_FILE = join(SAX_DIR, "orchestration-examples.json");
const MAX_EXAMPLES = 200;

function loadExamples(): OrchestrationExample[] {
  try {
    if (existsSync(EXAMPLES_FILE)) return JSON.parse(readFileSync(EXAMPLES_FILE, "utf-8"));
  } catch {}
  return [];
}

function saveExample(example: OrchestrationExample): void {
  const examples = loadExamples();
  examples.push(example);
  if (examples.length > MAX_EXAMPLES) examples.splice(0, examples.length - MAX_EXAMPLES);
  writeFileSync(EXAMPLES_FILE, JSON.stringify(examples, null, 2), "utf-8");
}

/** Rate a recent orchestration as good/bad (called by user feedback or auto-heuristic) */
export function rateOrchestration(index: number, quality: "good" | "bad", notes?: string): void {
  const examples = loadExamples();
  if (index >= 0 && index < examples.length) {
    examples[index].quality = quality;
    if (notes) examples[index].notes = notes;
    writeFileSync(EXAMPLES_FILE, JSON.stringify(examples, null, 2), "utf-8");
  }
}

/** Get recent examples for few-shot tuning */
export function getOrchestrationExamples(quality?: "good" | "bad"): OrchestrationExample[] {
  const examples = loadExamples();
  return quality ? examples.filter(e => e.quality === quality) : examples;
}

export interface BackgroundReport {
  consolidation: { merged: number; promoted: number };
  compression: { compressed: number; savedBytes: number };
  tierChanges: { hot: number; warm: number; cold: number; archive: number };
  prefetch: { topics: string[] };
  unspoken: { absences: number; changes: number };
  growth: string;
  narratives: number;
  totalTimeMs: number;
}

export interface HealthReport {
  modulesLoaded: string[];
  storageSizes: Record<string, number>;
  lastRunTimes: Record<string, number>;
  errorCounts: Record<string, number>;
  uptime: number;
}

// ── Constants ───────────────────────────────────────────────

const SAX_DIR = join(homedir(), ".sax");
const STATE_FILE = join(SAX_DIR, "orchestrator-state.json");

const SENSITIVE_KEYWORDS = [
  "died", "death", "passed away", "cancer", "depression", "anxiety",
  "breakup", "divorce", "fired", "laid off", "suicide", "abuse",
  "scared", "terrified", "lonely", "grief", "lost my", "struggling",
  "overwhelmed", "panic", "hurt", "trauma", "sick", "hospital",
  "emergency", "miscarriage", "relapse", "addiction",
];

const CORRECTION_KEYWORDS = [
  "no", "wrong", "incorrect", "not what", "that's not", "actually",
  "i meant", "you misunderstood", "i said", "nope", "nah",
  "that's wrong", "fix this", "you got it wrong",
];

const FACT_PATTERNS = [
  /\bi (am|work|live|use|prefer|like|hate|love|have|need|want)\b/i,
  /\bmy (name|job|project|favorite|preference|dog|cat|wife|husband|kid)\b/i,
  /\bi('m| am) (a |an )?[a-z]+ (developer|engineer|designer|manager|student)/i,
  /\bi (moved|switched|changed|started|quit|joined)\b/i,
];

const STORY_PATTERNS = [
  /\bso (basically|what happened|the thing is|long story)\b/i,
  /\byesterday|last (week|month|night|year)\b/i,
  /\bremember when\b/i,
  /\bback when\b/i,
  /\bthe other day\b/i,
];

const MAX_CONTEXT_SIGNALS = 7;
const MAX_CONTEXT_TOKENS = 200;

// ── Orchestrator State ─────────────────────────────────────

interface OrchestratorState {
  messageCount: number;
  lastProcessedAt: number;
  lastBackgroundRun: number;
  lastSignalHashes: string[];   // avoid repeating the same hints
  errorLog: { module: string; error: string; timestamp: number }[];
  moduleRunTimes: Record<string, number>;
}

function loadState(): OrchestratorState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    }
  } catch { /* start fresh */ }
  return {
    messageCount: 0,
    lastProcessedAt: 0,
    lastBackgroundRun: 0,
    lastSignalHashes: [],
    errorLog: [],
    moduleRunTimes: {},
  };
}

function saveState(state: OrchestratorState): void {
  if (!existsSync(SAX_DIR)) mkdirSync(SAX_DIR, { recursive: true });
  const tmp = STATE_FILE + "." + randomBytes(4).toString("hex") + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  try { renameSync(tmp, STATE_FILE); } catch {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ── Module Wrappers ─────────────────────────────────────────

function safeRun<T>(name: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    orchestratorState.errorLog.push({ module: name, error: msg, timestamp: Date.now() });
    if (orchestratorState.errorLog.length > 200) orchestratorState.errorLog.splice(0, 100);
    return fallback;
  }
}

let orchestratorState = loadState();

// ── Triage Logic ────────────────────────────────────────────

interface TriageResult {
  always: string[];
  conditional: string[];
  scheduled: string[];
  triggered: string[];
}

function triageModules(input: OrchestratorInput, msgCount: number): TriageResult {
  const result: TriageResult = {
    always: ["emotional-memory", "language-mirror", "trust-engine"],
    conditional: [],
    scheduled: [],
    triggered: [],
  };

  const msg = input.message.toLowerCase();

  // Conditional — inside references for short/ambiguous messages
  if (input.message.length < 60 || /^(that|this|the one|you know|it|same)\b/i.test(input.message)) {
    result.conditional.push("inside-references");
  }

  // Conditional — anticipatory care (check for follow-ups)
  const care = safeRun("anticipatory-care", () => AnticipatoryCare.getInstance(), null);
  if (care) {
    const followUps = safeRun("anticipatory-care", () => care.getFollowUps(), []);
    if (followUps.length > 0) result.conditional.push("anticipatory-care");
    const proactive = safeRun("anticipatory-care", () => care.getProactiveMessage(input.timeOfDay), null);
    if (proactive) result.conditional.push("anticipatory-care");
  }

  // Conditional — vulnerability awareness
  if (SENSITIVE_KEYWORDS.some(kw => msg.includes(kw))) {
    result.conditional.push("vulnerability-awareness");
  }

  // Conditional — associative recall for rich context
  if (input.message.length > 30) {
    result.conditional.push("associative-recall");
  }

  // Conditional — proactive memory
  result.conditional.push("proactive-memory");

  // Conditional — cross-session learning
  if (msgCount % 5 === 0) {
    result.conditional.push("cross-session-learning");
  }

  // Conditional — shared history (relationship context)
  result.conditional.push("shared-history");

  // Scheduled — unspoken detector every 10th message
  if (msgCount % 10 === 0 && msgCount > 0) {
    result.scheduled.push("unspoken-detector");
  }

  // Scheduled — growth tracker every 20th message
  if (msgCount % 20 === 0 && msgCount > 0) {
    result.scheduled.push("growth-tracker");
  }

  // Scheduled — narrative memory for story-like content
  if (STORY_PATTERNS.some(p => p.test(input.message))) {
    result.scheduled.push("narrative-memory");
  }

  // Triggered — milestone celebrations
  if (msgCount > 0 && (msgCount % 25 === 0 || msgCount === 1 || msgCount === 10 || msgCount === 50 || msgCount === 100)) {
    result.triggered.push("milestone-celebrations");
  }

  // Triggered — correction learning
  if (CORRECTION_KEYWORDS.some(kw => msg.includes(kw)) && input.agentPreviousMessage) {
    result.triggered.push("correction-learning");
  }

  // Triggered — contradiction detector for fact-like content
  if (FACT_PATTERNS.some(p => p.test(input.message))) {
    result.triggered.push("contradiction-detector");
  }

  // Deduplicate
  result.conditional = Array.from(new Set(result.conditional));
  result.scheduled = Array.from(new Set(result.scheduled));
  result.triggered = Array.from(new Set(result.triggered));

  return result;
}

// ── Signal Gathering ────────────────────────────────────────

function gatherSignals(input: OrchestratorInput, triage: TriageResult): ModuleSignal[] {
  const signals: ModuleSignal[] = [];
  const allModules = [...triage.always, ...triage.conditional, ...triage.scheduled, ...triage.triggered];

  for (const mod of allModules) {
    const collected = safeRun(mod, () => runModule(mod, input), []);
    signals.push(...collected);
  }

  // Ensure all signals have confidence (default based on priority)
  for (const sig of signals) {
    if (sig.confidence === undefined || sig.confidence === null) {
      sig.confidence = Math.min(1, sig.priority / 10);
    }
  }

  return signals;
}

function runModule(name: string, input: OrchestratorInput): ModuleSignal[] {
  const start = Date.now();
  const signals: ModuleSignal[] = [];

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
        });
      }
      // Check for emotional shift from recent history
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
          });
        }
      }
      break;
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
          });
        }
      }
      break;
    }

    case "trust-engine": {
      const trust = TrustEngine.getInstance();
      const level = trust.calculateTrustLevel();
      const stage = trust.getRelationshipStage();
      const adjustments = trust.getBehaviorAdjustments();
      signals.push({
        source: "trust-engine",
        signal: stage,
        priority: 3,
        category: "trust",
      });
      if (adjustments.personalReferences) {
        signals.push({
          source: "trust-engine",
          signal: "Relationship is close enough for personal references and callbacks to shared history",
          priority: 2,
          category: "trust-behavior",
        });
      }
      break;
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
        });
      }
      break;
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
        });
      }
      const proactive = care.getProactiveMessage(input.timeOfDay);
      if (proactive) {
        signals.push({
          source: "anticipatory-care",
          signal: proactive,
          priority: 5,
          category: "proactive",
        });
      }
      break;
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
        });
      }
      break;
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
        });
      }
      break;
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
        });
      }
      break;
    }

    case "cross-session-learning": {
      const csl = crossSessionLearner;
      const patterns = csl.detectPatterns(3);
      if (patterns.length > 0) {
        const top = patterns[0];
        signals.push({
          source: "cross-session-learning",
          signal: `Recurring pattern: ${top.description} (seen ${top.occurrences}x)`,
          priority: 3,
          category: "pattern",
        });
      }
      break;
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
          });
        }
      }
      break;
    }

    case "unspoken-detector": {
      const ud = UnspokenDetector.getInstance();
      const absences = ud.detectAbsence();
      if (absences.length > 0) {
        const hint = ud.getSensitivityHint(absences);
        if (hint) {
          signals.push({
            source: "unspoken-detector",
            signal: hint,
            priority: 6,
            category: "unspoken",
          });
        }
      }
      const changes = ud.detectBehaviorChange();
      if (changes.length > 0) {
        signals.push({
          source: "unspoken-detector",
          signal: `Behavior change: ${changes[0].description}`,
          priority: 5,
          category: "behavior-change",
        });
      }
      break;
    }

    case "growth-tracker": {
      const gt = GrowthTracker.getInstance();
      const summary = gt.getGrowthSummary();
      if (summary && summary.length > 10) {
        signals.push({
          source: "growth-tracker",
          signal: summary,
          priority: 3,
          category: "growth",
        });
      }
      break;
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
        });
      }
      const ongoing = nm.getOngoingStories();
      if (ongoing.length > 0 && !detected) {
        signals.push({
          source: "narrative-memory",
          signal: `Continuing narrative: "${ongoing[0].title}"`,
          priority: 3,
          category: "narrative",
        });
      }
      break;
    }

    case "milestone-celebrations": {
      const mc = MilestoneCelebrator.getInstance();
      const sh = SharedHistory.getInstance();
      const summary = sh.getRelationshipSummary();
      const context = {
        conversationCount: summary.totalConversations || 0,
        appCount: summary.totalApps || 0,
        daysTogether: summary.daysTogether || 0,
        toolsUsed: [] as string[],
        streak: 0,
      };
      const milestones = mc.checkMilestones(context);
      for (const m of milestones) {
        const celebration = mc.celebrate(m);
        signals.push({
          source: "milestone-celebrations",
          signal: celebration,
          priority: 8,
          category: "milestone",
        });
      }
      break;
    }

    case "correction-learning": {
      if (!input.agentPreviousMessage) break;
      const cl = CorrectionLearner.getInstance();
      const correction = cl.detectCorrection(input.message, input.agentPreviousMessage);
      if (correction) {
        signals.push({
          source: "correction-learning",
          signal: `User is correcting: "${correction.wrongInfo}" should be "${correction.correctInfo}" — avoid repeating this mistake`,
          priority: 9,
          category: "correction",
        });
        const context = cl.getCorrectiveContext(correction.wrongInfo);
        if (context) {
          signals.push({
            source: "correction-learning",
            signal: context,
            priority: 8,
            category: "correction-context",
          });
        }
      }
      break;
    }

    case "contradiction-detector": {
      const cd = ContradictionDetector.getInstance();
      const history = cd.getContradictionHistory();
      const existingFacts = history.map(r => r.contradiction.oldFact);
      if (existingFacts.length > 0) {
        const contradiction = cd.checkContradiction(input.message, existingFacts);
        if (contradiction) {
          signals.push({
            source: "contradiction-detector",
            signal: `Possible contradiction: "${contradiction.oldFact}" vs "${contradiction.newFact}" — gently clarify`,
            priority: 7,
            category: "contradiction",
          });
        }
      }
      break;
    }
  }

  orchestratorState.moduleRunTimes[name] = Date.now() - start;
  return signals;
}

// ── Signal Merging ──────────────────────────────────────────

function hashSignal(s: ModuleSignal): string {
  return s.category + ":" + s.signal.slice(0, 40);
}

function mergeSignals(signals: ModuleSignal[], previousHashes: string[]): { paragraph: string; usedSignals: ModuleSignal[]; hashes: string[] } {
  // Sort by priority descending
  const sorted = [...signals].sort((a, b) => b.priority - a.priority);

  // Deduplicate by category — keep highest priority per category
  const seen = new Set<string>();
  const deduped: ModuleSignal[] = [];
  for (const sig of sorted) {
    // Allow max 2 signals per category
    const catCount = deduped.filter(s => s.category === sig.category).length;
    if (catCount >= 2) continue;

    const hash = hashSignal(sig);
    if (seen.has(hash)) continue;
    seen.add(hash);
    deduped.push(sig);
  }

  // Filter out signals that were in the previous injection (avoid repetition)
  const prevSet = new Set(previousHashes);
  const fresh = deduped.filter(s => !prevSet.has(hashSignal(s)));
  // If filtering removed everything, fall back to deduped
  const candidates = fresh.length > 0 ? fresh : deduped;

  // Take top N
  const top = candidates.slice(0, MAX_CONTEXT_SIGNALS);

  // Build natural prose paragraph
  const paragraph = buildParagraph(top);

  return {
    paragraph,
    usedSignals: top,
    hashes: top.map(hashSignal),
  };
}

function buildParagraph(signals: ModuleSignal[]): string {
  if (signals.length === 0) return "";

  // Group into natural sentence clusters
  const parts: string[] = [];

  // Vulnerability/correction first — most important behavioral guidance
  const critical = signals.filter(s => s.category === "vulnerability" || s.category === "correction" || s.category === "correction-context");
  const emotional = signals.filter(s => s.category === "emotion" || s.category === "emotion-shift");
  const relational = signals.filter(s => s.category === "trust" || s.category === "trust-behavior" || s.category === "history");
  const contextual = signals.filter(s => s.category === "reference" || s.category === "recall" || s.category === "narrative" || s.category === "followup" || s.category === "proactive");
  const observational = signals.filter(s => s.category === "style" || s.category === "growth" || s.category === "pattern" || s.category === "milestone" || s.category === "unspoken" || s.category === "behavior-change" || s.category === "contradiction");

  for (const sig of critical) parts.push(sig.signal);
  for (const sig of emotional) parts.push(sig.signal);
  for (const sig of relational.slice(0, 1)) parts.push(sig.signal);
  for (const sig of contextual.slice(0, 2)) parts.push(sig.signal);
  for (const sig of observational.slice(0, 2)) parts.push(sig.signal);

  if (parts.length === 0) return "";

  // Join into flowing prose, cleaning up redundant punctuation
  let text = parts
    .map(p => p.trim())
    .filter(p => p.length > 0)
    .map(p => p.endsWith(".") || p.endsWith("!") || p.endsWith("?") ? p : p + ".")
    .join(" ");

  // Rough token budget: ~4 chars per token, cap at 800 chars (~200 tokens)
  if (text.length > 800) {
    text = text.slice(0, 797) + "...";
  }

  return text;
}

// ── Notification Extraction ─────────────────────────────────

function extractNotifications(signals: ModuleSignal[], input: OrchestratorInput): Notification[] {
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

// ── Recording ───────────────────────────────────────────────

function recordFromMessage(input: OrchestratorInput): void {
  // Emotion recording
  safeRun("emotional-memory:record", () => {
    const emotion = EmotionalMemory.detectEmotion(input.message);
    if (emotion.confidence > 0.2) {
      EmotionalMemory.recordEmotion(input.sessionId, emotion, input.message.slice(0, 100));
    }
  }, undefined);

  // Language style recording
  safeRun("language-mirror:record", () => {
    LanguageMirror.getInstance().recordUserStyle(input.message);
  }, undefined);

  // Trust signal recording
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

  // Shared history — record if message is substantive
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

  // Proactive memory interaction recording
  safeRun("proactive-memory:record", () => {
    ProactiveMemory.recordInteraction(input.sessionId, input.message, Date.now());
  }, undefined);

  // Vulnerability recording
  safeRun("vulnerability-awareness:record", () => {
    const vuln = VulnerabilityAwareness.getInstance();
    const share = vuln.detectVulnerability(input.message);
    if (share) {
      vuln.recordVulnerableShare(share);
    }
  }, undefined);

  // Correction recording
  safeRun("correction-learning:record", () => {
    if (input.agentPreviousMessage) {
      const cl = CorrectionLearner.getInstance();
      const correction = cl.detectCorrection(input.message, input.agentPreviousMessage);
      if (correction) {
        cl.recordCorrection(correction);
      }
    }
  }, undefined);

  // Predictive prefetcher schedule learning
  safeRun("predictive-prefetch:record", () => {
    const words = input.message.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    PredictivePrefetcher.getInstance().learnSchedule(Date.now(), words.slice(0, 10), []);
  }, undefined);

  // Associative learning — link current message concepts
  safeRun("associative-recall:record", () => {
    const words = input.message.split(/\s+/).filter(w => w.length > 5);
    if (words.length >= 2) {
      const assoc = AssociativeMemory.getInstance();
      assoc.learnAssociation(words[0], words[1], "co-occurrence", 0.3);
    }
  }, undefined);
}

// ── Orchestrator Class ──────────────────────────────────────

export class MemoryOrchestrator {
  private static instance: MemoryOrchestrator;

  private constructor() {}

  static getInstance(): MemoryOrchestrator {
    if (!MemoryOrchestrator.instance) {
      MemoryOrchestrator.instance = new MemoryOrchestrator();
    }
    return MemoryOrchestrator.instance;
  }

  /**
   * Process a single user message through the memory system.
   * This is the ONE method the server calls per message.
   */
  processMessage(input: OrchestratorInput): OrchestratorOutput {
    const startTime = Date.now();
    orchestratorState.messageCount++;

    // 1. TRIAGE — decide which modules to activate
    const triage = triageModules(input, orchestratorState.messageCount);
    const allActivated = [...triage.always, ...triage.conditional, ...triage.scheduled, ...triage.triggered];

    // 2. GATHER — run activated modules, collect signals
    let signals = gatherSignals(input, triage);

    // 2.5 VETO LAYER — sacred/vulnerability signals override normal flow
    const veto = applyVetoLayer(signals);
    if (veto.vetoed && veto.overrideSignal) {
      // Push the override signal to top priority
      signals = signals.filter(s => s.source !== veto.overrideSignal!.source);
      signals.unshift(veto.overrideSignal);
    }

    // 2.6 CONFIDENCE CHECK — if critical modules have low confidence, run deeper
    const deepPass = checkDeepPassNeeded(signals, allActivated);
    if (deepPass.needed) {
      // Re-run low-confidence critical modules with broader context (more session messages)
      for (const mod of deepPass.modules) {
        const deepSignal = safeRun(mod + "-deep", () => {
          // Run with more context for higher confidence
          const expandedInput = { ...input, sessionMessages: input.sessionMessages.slice(-40) };
          return gatherSignals(expandedInput, { always: [mod], conditional: [], scheduled: [], triggered: [] });
        }, []);
        if (deepSignal.length > 0) {
          // Replace the low-confidence signal with the deeper one
          signals = signals.filter(s => s.source !== mod);
          signals.push(...deepSignal);
        }
      }
    }

    // 3. MERGE — combine into one coherent context injection
    const merged = mergeSignals(signals, orchestratorState.lastSignalHashes);

    // 3.5 FUSION CONFIDENCE — overall confidence score
    const fusionConfidence = calculateFusionConfidence(merged.usedSignals);

    // 4. EXTRACT NOTIFICATIONS
    const notifications = extractNotifications(signals, input);

    // 5. RECORD — update modules with new data
    const adaptations = buildAdaptations(signals);

    // Build debug info
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

    // Record data from this message (happens after output is generated)
    safeRun("recording", () => recordFromMessage(input), undefined);

    // 6. SAVE ORCHESTRATION EXAMPLE — for tuning
    safeRun("save-example", () => {
      saveExample({
        input: { message: input.message.slice(0, 200), timeOfDay: input.timeOfDay },
        modulesActivated: allActivated,
        signals: merged.usedSignals.map(s => ({ ...s, signal: s.signal.slice(0, 100) })),
        output: merged.paragraph.slice(0, 300),
        quality: "neutral", // starts neutral, can be rated later
        timestamp: Date.now(),
      });
    }, undefined);

    // Update state
    orchestratorState.lastProcessedAt = Date.now();
    orchestratorState.lastSignalHashes = merged.hashes;
    saveState(orchestratorState);

    return output;
  }

  /**
   * Run heavy background tasks — called by cron/nightly, never inline.
   */
  runBackground(): BackgroundReport {
    const startTime = Date.now();

    // Memory consolidation
    const consolidation = safeRun("memory-consolidation:bg", () => {
      const mc = MemoryConsolidator.getInstance();
      const report = mc.consolidate();
      return { merged: report.mergedCount, promoted: report.promotedCount };
    }, { merged: 0, promoted: 0 });

    // Memory compression
    const compression = safeRun("memory-compression:bg", () => {
      const mc = MemoryCompressor.getInstance();
      const report = mc.compressAll(false);
      return { compressed: report.compressed, savedBytes: report.savedTokens };
    }, { compressed: 0, savedBytes: 0 });

    // Tier reclassification
    const tierChanges = safeRun("memory-tiers:bg", () => {
      const tm = MemoryTierManager.getInstance();
      const report = tm.reclassifyAll();
      return report.tierCounts;
    }, { hot: 0, warm: 0, cold: 0, archive: 0 });

    // Predictive prefetch
    const prefetch = safeRun("predictive-prefetch:bg", () => {
      const pp = PredictivePrefetcher.getInstance();
      const now = new Date();
      const result = pp.prefetch(now.getHours(), now.getDay());
      return { topics: result.predictions.map((t: { topic: string }) => t.topic) };
    }, { topics: [] as string[] });

    // Unspoken detection full scan
    const unspoken = safeRun("unspoken-detector:bg", () => {
      const ud = UnspokenDetector.getInstance();
      const absences = ud.detectAbsence();
      const changes = ud.detectBehaviorChange();
      return { absences: absences.length, changes: changes.length };
    }, { absences: 0, changes: 0 });

    // Growth summary generation
    const growth = safeRun("growth-tracker:bg", () => {
      return GrowthTracker.getInstance().getGrowthSummary();
    }, "");

    // Narrative arc updates
    const narratives = safeRun("narrative-memory:bg", () => {
      const nm = NarrativeMemory.getInstance();
      return nm.getOngoingStories().length;
    }, 0);

    orchestratorState.lastBackgroundRun = Date.now();
    saveState(orchestratorState);

    return {
      consolidation,
      compression,
      tierChanges,
      prefetch,
      unspoken,
      growth,
      narratives,
      totalTimeMs: Date.now() - startTime,
    };
  }

  /**
   * System health diagnostics.
   */
  getSystemHealth(): HealthReport {
    const modulesLoaded: string[] = [];
    const storageSizes: Record<string, number> = {};

    // Check which modules can be instantiated
    const moduleChecks: [string, () => unknown][] = [
      ["emotional-memory", () => EmotionalMemory],
      ["memory-graph", () => MemoryGraph],
      ["proactive-memory", () => ProactiveMemory],
      ["memory-importance", () => MemoryImportance],
      ["cross-session-learning", () => CrossSessionLearnerClass.getInstance()],
      ["narrative-memory", () => NarrativeMemory.getInstance()],
      ["unspoken-detector", () => UnspokenDetector.getInstance()],
      ["inside-references", () => InsideReferences.getInstance()],
      ["growth-tracker", () => GrowthTracker.getInstance()],
      ["anticipatory-care", () => AnticipatoryCare.getInstance()],
      ["shared-history", () => SharedHistory.getInstance()],
      ["language-mirror", () => LanguageMirror.getInstance()],
      ["trust-engine", () => TrustEngine.getInstance()],
      ["milestone-celebrations", () => MilestoneCelebrator.getInstance()],
      ["vulnerability-awareness", () => VulnerabilityAwareness.getInstance()],
      ["correction-learning", () => CorrectionLearner.getInstance()],
      ["memory-tiers", () => MemoryTierManager.getInstance()],
      ["contradiction-detector", () => ContradictionDetector.getInstance()],
      ["associative-recall", () => AssociativeMemory.getInstance()],
      ["predictive-prefetch", () => PredictivePrefetcher.getInstance()],
      ["memory-compression", () => MemoryCompressor.getInstance()],
      ["memory-consolidation", () => MemoryConsolidator.getInstance()],
    ];

    for (const [name, check] of moduleChecks) {
      try {
        check();
        modulesLoaded.push(name);
      } catch { /* module failed to load */ }
    }

    // Check storage files
    const storageFiles: Record<string, string> = {
      "emotional-memory": "emotional-history.json",
      "language-mirror": "language-style.json",
      "trust-engine": "trust-engine.json",
      "milestones": "milestones.json",
      "vulnerability": "vulnerability-shares.json",
      "corrections": "corrections.json",
      "shared-history": "shared-history.json",
      "inside-references": "inside-references.json",
      "growth-tracker": "growth-tracker.json",
      "narrative-memory": "narratives.json",
      "unspoken-detector": "unspoken-detector.json",
      "orchestrator": "orchestrator-state.json",
    };

    for (const [name, file] of Object.entries(storageFiles)) {
      const path = join(SAX_DIR, file);
      try {
        if (existsSync(path)) {
          const stat = readFileSync(path, "utf-8");
          storageSizes[name] = stat.length;
        }
      } catch { /* skip */ }
    }

    // Error counts by module
    const errorCounts: Record<string, number> = {};
    for (const err of orchestratorState.errorLog) {
      errorCounts[err.module] = (errorCounts[err.module] || 0) + 1;
    }

    return {
      modulesLoaded,
      storageSizes,
      lastRunTimes: { ...orchestratorState.moduleRunTimes },
      errorCounts,
      uptime: Date.now() - (orchestratorState.lastProcessedAt || Date.now()),
    };
  }
}

// ── Adaptation Builder ──────────────────────────────────────

function buildAdaptations(signals: ModuleSignal[]): Adaptation[] {
  const adaptations: Adaptation[] = [];

  for (const sig of signals) {
    if (sig.category === "vulnerability") {
      adaptations.push({
        type: "tone",
        instruction: "Be extra gentle and empathetic. Avoid being dismissive or clinical.",
        priority: 9,
      });
    }
    if (sig.category === "correction" || sig.category === "correction-context") {
      adaptations.push({
        type: "accuracy",
        instruction: "User just corrected you. Acknowledge the mistake directly and adjust.",
        priority: 9,
      });
    }
    if (sig.category === "emotion" && sig.signal.includes("frustrated")) {
      adaptations.push({
        type: "pace",
        instruction: "User seems frustrated. Be concise, solution-oriented, skip pleasantries.",
        priority: 7,
      });
    }
    if (sig.category === "emotion" && (sig.signal.includes("excited") || sig.signal.includes("happy"))) {
      adaptations.push({
        type: "energy",
        instruction: "Match the user's positive energy. Be enthusiastic.",
        priority: 4,
      });
    }
    if (sig.category === "contradiction") {
      adaptations.push({
        type: "clarification",
        instruction: "Something contradicts earlier information. Gently ask to clarify, don't assume.",
        priority: 7,
      });
    }
    if (sig.category === "style") {
      adaptations.push({
        type: "style",
        instruction: sig.signal,
        priority: 3,
      });
    }
  }

  // Deduplicate by type, keep highest priority
  const byType = new Map<string, Adaptation>();
  for (const a of adaptations.sort((x, y) => y.priority - x.priority)) {
    if (!byType.has(a.type)) byType.set(a.type, a);
  }

  return Array.from(byType.values());
}

// ── Convenience export ──────────────────────────────────────

export function processMessage(input: OrchestratorInput): OrchestratorOutput {
  return MemoryOrchestrator.getInstance().processMessage(input);
}
