import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { AgentTurn } from "../types.js";
import type { AgentOptions, ImageAttachment } from "./types.js";

export async function buildAnthropicUserContent(
  userMessage: string,
  images: ImageAttachment[] | undefined,
): Promise<ChatCompletionMessageParam["content"]> {
  let userContent: ChatCompletionMessageParam["content"] = userMessage;
  if (images && images.length > 0) {
    const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: string } }> = [
      { type: "text", text: userMessage },
    ];
    const filePathHintsA: string[] = [];
    for (const img of images) {
      try {
        const { readFileSync } = await import("node:fs");
        const data = readFileSync(img.filePath || "");
        const ext = (img.name.split(".").pop() || "png").toLowerCase();
        const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
        const b64 = `data:${mime};base64,${data.toString("base64")}`;
        parts.push({ type: "image_url", image_url: { url: b64, detail: "auto" } });
        if (img.filePath) filePathHintsA.push(`  - ${img.name} → ${img.filePath}`);
      } catch (e) {
        console.warn(`[agent] Could not read image ${img.name}:`, e);
      }
    }
    if (filePathHintsA.length > 0) {
      parts.push({
        type: "text",
        text:
          `\n\n[Attached file paths on disk — use these if you need to copy the real bytes into the workspace]\n` +
          filePathHintsA.join("\n") +
          `\n\nTo use an attachment as an app asset: read the file with bash/read, then write it to the target path under workspace/apps/<app>/, or use bash cp. Do NOT generate a new image or download from the web when a user attachment exists — use the file at the path above.`,
      });
    }
    userContent = parts as ChatCompletionMessageParam["content"];
  }
  return userContent;
}

export interface AnthropicSafetyState {
  messages: ChatCompletionMessageParam[];
  systemPrompt: string;
  totalInput: number;
  totalOutput: number;
  turnStartMs: number;
  iteration: number;
  committingToolsThisTurn: Set<string>;
  evidenceHistory: number[];
  options: AgentOptions;
  model: string;
  tokenCeiling: number;
  wallClockMs: number;
  midTurnMinIteration: number;
  midTurnEvidenceStaleWindow: number;
}

export function checkAnthropicTurnSafetyCeilings(state: AnthropicSafetyState): AgentTurn | null {
  const {
    messages,
    systemPrompt,
    totalInput,
    totalOutput,
    turnStartMs,
    iteration,
    committingToolsThisTurn,
    evidenceHistory,
    options,
    model,
    tokenCeiling,
    wallClockMs,
    midTurnMinIteration,
    midTurnEvidenceStaleWindow,
  } = state;

  if (totalInput + totalOutput > tokenCeiling) {
    const abortMsg = `Turn token ceiling hit: ${totalInput + totalOutput} tokens used (cap ${tokenCeiling}). Aborting.`;
    console.warn(`[agent] ${abortMsg}`);
    try { import("../retry-telemetry.js").then(({ logRetry }) => logRetry({ kind: "custom", sessionId: options.sessionId, provider: "anthropic", model, detail: { reason: "turn-token-ceiling", totalInput, totalOutput } })).catch(() => {}); } catch {}
    return {
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput },
      stopReason: "error",
      errorMessage: abortMsg,
    };
  }

  const turnElapsedA = Date.now() - turnStartMs;
  if (turnElapsedA > wallClockMs && committingToolsThisTurn.size === 0) {
    const abortMsg = `Wall-clock turn ceiling hit (Anthropic): ${Math.round(turnElapsedA / 1000)}s, iteration ${iteration}, no committing tool. Aborting.`;
    console.warn(`[agent] ${abortMsg}`);
    try { import("../retry-telemetry.js").then(({ logRetry }) => logRetry({ kind: "custom", sessionId: options.sessionId, provider: "anthropic", model, detail: { reason: "turn-wall-clock", elapsedMs: turnElapsedA, iteration } })).catch(() => {}); } catch {}
    return {
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput },
      stopReason: "error",
      errorMessage: abortMsg,
    };
  }
  if (iteration >= midTurnMinIteration && evidenceHistory.length >= midTurnEvidenceStaleWindow && committingToolsThisTurn.size === 0) {
    const wA = evidenceHistory.slice(-midTurnEvidenceStaleWindow);
    if (wA.every(v => v === wA[0])) {
      const abortMsg = `Mid-turn evidence stale (Anthropic): ${wA[0]} evidence for ${midTurnEvidenceStaleWindow} iterations with no committing tool. Aborting.`;
      console.warn(`[agent] ${abortMsg}`);
      try { import("../retry-telemetry.js").then(({ logRetry }) => logRetry({ kind: "custom", sessionId: options.sessionId, provider: "anthropic", model, detail: { reason: "mid-turn-stale", iteration, evidence: wA } })).catch(() => {}); } catch {}
      return {
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        usage: { promptTokens: totalInput, completionTokens: totalOutput, totalTokens: totalInput + totalOutput },
        stopReason: "error",
        errorMessage: abortMsg,
      };
    }
  }
  return null;
}
