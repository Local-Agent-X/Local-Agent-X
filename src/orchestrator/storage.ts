import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { OrchestrationExample } from "./types.js";
import { EXAMPLES_FILE, MAX_EXAMPLES } from "./types.js";

export function loadExamples(): OrchestrationExample[] {
  try {
    if (existsSync(EXAMPLES_FILE)) return JSON.parse(readFileSync(EXAMPLES_FILE, "utf-8"));
  } catch {}
  return [];
}

export function saveExample(example: OrchestrationExample): void {
  const examples = loadExamples();
  examples.push(example);
  if (examples.length > MAX_EXAMPLES) examples.splice(0, examples.length - MAX_EXAMPLES);
  writeFileSync(EXAMPLES_FILE, JSON.stringify(examples, null, 2), "utf-8");
}

export function rateOrchestration(index: number, quality: "good" | "bad", notes?: string): void {
  const examples = loadExamples();
  if (index >= 0 && index < examples.length) {
    examples[index].quality = quality;
    if (notes) examples[index].notes = notes;
    writeFileSync(EXAMPLES_FILE, JSON.stringify(examples, null, 2), "utf-8");
  }
}

export function getOrchestrationExamples(quality?: "good" | "bad"): OrchestrationExample[] {
  const examples = loadExamples();
  return quality ? examples.filter(e => e.quality === quality) : examples;
}

export function autoRateLastExample(userReply: string): void {
  const examples = loadExamples();
  if (examples.length === 0) return;
  const last = examples[examples.length - 1];
  if (last.quality !== "neutral") return;

  const lower = userReply.toLowerCase();

  const positiveWords = ["thanks", "perfect", "great", "awesome", "exactly", "yes", "nice", "love", "good", "cool"];
  const negativeWords = ["wrong", "no", "stop", "not what", "that's not", "you forgot", "already told", "i said", "fix"];

  let posScore = 0, negScore = 0;
  for (const w of positiveWords) { if (lower.includes(w)) posScore++; }
  for (const w of negativeWords) { if (lower.includes(w)) negScore++; }

  if (userReply.length > 100) posScore++;
  if (userReply.length < 10 && last.output.length > 200) negScore++;

  if (posScore > negScore && posScore >= 2) {
    last.quality = "good";
    last.notes = "auto-rated: positive user response";
  } else if (negScore > posScore && negScore >= 2) {
    last.quality = "bad";
    last.notes = "auto-rated: negative user response";
  }

  writeFileSync(EXAMPLES_FILE, JSON.stringify(examples, null, 2), "utf-8");
}
