import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { AgentTurn } from "../types.js";
import type { AgentOptions, ImageAttachment } from "./types.js";

export async function buildUserContentWithImages(
  userMessage: string,
  images: ImageAttachment[] | undefined,
): Promise<ChatCompletionMessageParam["content"]> {
  if (!images || images.length === 0) return userMessage;
  const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: string } }> = [
    { type: "text", text: userMessage },
  ];
  const filePathHints: string[] = [];
  for (const img of images) {
    try {
      const { readFileSync } = await import("node:fs");
      const data = readFileSync(img.filePath || "");
      const ext = (img.name.split(".").pop() || "png").toLowerCase();
      const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      const b64 = `data:${mime};base64,${data.toString("base64")}`;
      parts.push({ type: "image_url", image_url: { url: b64, detail: "auto" } });
      if (img.filePath) filePathHints.push(`  - ${img.name} → ${img.filePath}`);
    } catch (e) {
      console.warn(`[agent] Could not read image ${img.name}:`, e);
    }
  }
  if (filePathHints.length > 0) {
    parts.push({
      type: "text",
      text:
        `\n\n[Attached file paths on disk — use these if you need to copy the real bytes into the workspace]\n` +
        filePathHints.join("\n") +
        `\n\nTo use an attachment as an app asset: read the file with bash/read, then write it to the target path under workspace/apps/<app>/, or use bash cp. Do NOT generate a new image or download from the web when a user attachment exists — use the file at the path above.`,
    });
  }
  return parts as ChatCompletionMessageParam["content"];
}

export interface StandardSafetyState {
  messages: ChatCompletionMessageParam[];
  totalPromptTokens: number;
  totalCompletionTokens: number;
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

export function checkStandardTurnSafetyCeilings(state: StandardSafetyState): AgentTurn | null {
  const {
    messages,
    totalPromptTokens,
    totalCompletionTokens,
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

  if (totalPromptTokens + totalCompletionTokens > tokenCeiling) {
    const abortMsg = `Turn token ceiling hit: ${totalPromptTokens + totalCompletionTokens} tokens used (cap ${tokenCeiling}). Aborting.`;
    console.warn(`[agent] ${abortMsg}`);
    try { import("../retry-telemetry.js").then(({ logRetry }) => logRetry({ kind: "custom", sessionId: options.sessionId, provider: options.provider, model, detail: { reason: "turn-token-ceiling", totalInput: totalPromptTokens, totalOutput: totalCompletionTokens } })).catch(() => {}); } catch {}
    return {
      messages,
      usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, totalTokens: totalPromptTokens + totalCompletionTokens },
      stopReason: "error",
      errorMessage: abortMsg,
    };
  }

  const turnElapsed = Date.now() - turnStartMs;
  if (turnElapsed > wallClockMs && committingToolsThisTurn.size === 0) {
    const abortMsg = `Wall-clock turn ceiling hit: ${Math.round(turnElapsed / 1000)}s, iteration ${iteration}, no committing tool. Aborting.`;
    console.warn(`[agent] ${abortMsg}`);
    try { import("../retry-telemetry.js").then(({ logRetry }) => logRetry({ kind: "custom", sessionId: options.sessionId, provider: options.provider, model, detail: { reason: "turn-wall-clock", elapsedMs: turnElapsed, iteration } })).catch(() => {}); } catch {}
    return {
      messages,
      usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, totalTokens: totalPromptTokens + totalCompletionTokens },
      stopReason: "error",
      errorMessage: abortMsg,
    };
  }
  if (iteration >= midTurnMinIteration && evidenceHistory.length >= midTurnEvidenceStaleWindow && committingToolsThisTurn.size === 0) {
    const w = evidenceHistory.slice(-midTurnEvidenceStaleWindow);
    if (w.every(v => v === w[0])) {
      const abortMsg = `Mid-turn evidence stale: ${w[0]} evidence for ${midTurnEvidenceStaleWindow} iterations with no committing tool. Aborting.`;
      console.warn(`[agent] ${abortMsg}`);
      try { import("../retry-telemetry.js").then(({ logRetry }) => logRetry({ kind: "custom", sessionId: options.sessionId, provider: options.provider, model, detail: { reason: "mid-turn-stale", iteration, evidence: w } })).catch(() => {}); } catch {}
      return {
        messages,
        usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, totalTokens: totalPromptTokens + totalCompletionTokens },
        stopReason: "error",
        errorMessage: abortMsg,
      };
    }
  }
  return null;
}
