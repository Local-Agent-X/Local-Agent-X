import type { RouteHandler } from "../../server-context.js";
import { jsonResponse, readBody } from "../../server-utils.js";

export const handleMoodRoutes: RouteHandler = async (method, url, req, res, _ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // Mood detection
  if (method === "POST" && url.pathname === "/api/mood/detect") {
    let body: Record<string, unknown>;
    try { body = JSON.parse(await readBody(req)); } catch { json(400, { error: "Invalid JSON" }); return true; }
    const text = String(body.text || "");
    if (!text) { json(400, { error: "text required" }); return true; }
    const lower = text.toLowerCase();
    const positiveWords = ["thanks", "great", "awesome", "perfect", "love", "excellent", "amazing", "happy", "good", "nice", "wonderful", "fantastic", "brilliant", "appreciate", "excited", "glad", "pleased", "helpful", "beautiful"];
    const negativeWords = ["frustrated", "angry", "annoyed", "broken", "bug", "wrong", "error", "fail", "hate", "terrible", "awful", "bad", "worst", "stuck", "confused", "disappointed", "problem", "issue", "unfortunately", "sucks"];
    const urgentWords = ["urgent", "asap", "immediately", "critical", "emergency", "deadline", "hurry", "rush"];
    const casualWords = ["hey", "hi", "yo", "lol", "haha", "btw", "nah", "yeah", "cool", "sup", "chill"];
    const formalWords = ["please", "kindly", "would you", "could you", "regarding", "concerning", "pursuant", "hereby"];
    let posScore = 0, negScore = 0, urgentScore = 0, casualScore = 0, formalScore = 0;
    for (const w of positiveWords) { if (lower.includes(w)) posScore++; }
    for (const w of negativeWords) { if (lower.includes(w)) negScore++; }
    for (const w of urgentWords) { if (lower.includes(w)) urgentScore++; }
    for (const w of casualWords) { if (lower.includes(w)) casualScore++; }
    for (const w of formalWords) { if (lower.includes(w)) formalScore++; }
    const exclamations = (text.match(/!/g) || []).length;
    const capsRatio = (text.match(/[A-Z]/g) || []).length / Math.max(text.length, 1);
    if (exclamations > 2) urgentScore++;
    if (capsRatio > 0.5 && text.length > 10) urgentScore++;
    let mood = "neutral", tone = "balanced", confidence = 0.5;
    if (posScore > negScore && posScore > 0) { mood = "positive"; confidence = Math.min(0.9, 0.5 + posScore * 0.1); }
    else if (negScore > posScore && negScore > 0) { mood = "negative"; confidence = Math.min(0.9, 0.5 + negScore * 0.1); }
    else if (urgentScore > 0) { mood = "urgent"; confidence = Math.min(0.9, 0.5 + urgentScore * 0.15); }
    if (casualScore > formalScore) tone = "casual";
    else if (formalScore > casualScore) tone = "formal";
    let styleHint = "";
    if (mood === "negative") styleHint = "User seems frustrated. Be empathetic and focus on solutions.";
    else if (mood === "urgent") styleHint = "User has urgency. Be concise, prioritize action.";
    else if (mood === "positive") styleHint = "User is in a good mood. Match their energy.";
    if (tone === "casual") styleHint += " Keep responses casual.";
    else if (tone === "formal") styleHint += " Match their formal tone.";
    json(200, { mood, tone, confidence, styleHint, scores: { positive: posScore, negative: negScore, urgent: urgentScore, casual: casualScore, formal: formalScore } });
    return true;
  }

  return false;
};
