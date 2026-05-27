/**
 * Layer 1 — intent gate. Sanity-check the self_edit task against the
 * user's most recent message via a small LLM call on the SAME provider+
 * model the chat is currently using (no provider hardcode → no migration
 * tax when switching models). Returns null on any classifier failure
 * (no creds, timeout, parse error) and the caller fails open.
 *
 * The gate prompt is intentionally narrow: "does the task match the
 * intent?" rather than open-ended. Yes/no/unsure with a one-line
 * reason. Tiny output, fast classification, low chance of weird drift.
 */
export async function checkSelfEditIntent(
  task: string,
  lastUserMessage: string,
  lastAssistantMessage: string,
): Promise<{ verdict: "match" | "mismatch" | "unsure"; reason: string } | null> {
  try {
    const { getRuntimeConfig } = await import("../config.js");
    const { getOrInitSecretsStore } = await import("../secrets.js");
    const { resolveProvider } = await import("../agent-request.js");
    const { getLaxDir } = await import("../lax-data-dir.js");

    const runtime = getRuntimeConfig();
    const dataDir = getLaxDir();
    const secretsStore = getOrInitSecretsStore(dataDir);
    const resolved = await resolveProvider(runtime, secretsStore, dataDir);
    if (!resolved.apiKey) return null;

    const prompt =
      `You are a sanity-check classifier for a destructive tool. Decide if a self_edit task description matches what the user is actually asking for.\n\n` +
      `self_edit modifies the agent's own source code. It should ONLY run when the user wants source-code changes (bug fix, missing capability) related to the chat.\n\n` +
      `User's most recent message:\n"""${lastUserMessage.slice(0, 600)}"""\n\n` +
      (lastAssistantMessage ? `Most recent assistant text:\n"""${lastAssistantMessage.slice(0, 400)}"""\n\n` : "") +
      `self_edit task being submitted:\n"""${task.slice(0, 600)}"""\n\n` +
      `Reply with ONE LINE of JSON, nothing else:\n` +
      `{"verdict": "match" | "mismatch" | "unsure", "reason": "<one short sentence>"}\n\n` +
      `- "match": the task addresses the same intent the user expressed (e.g. user asks "fix the chat freeze", task says "fix race in chat-ws.ts where streamingSessionId leaks")\n` +
      `- "mismatch": the task is on a different topic, or solves a problem the user didn't ask about (e.g. user says "launch the installer", task says "edit cron jobs")\n` +
      `- "unsure": ambiguous — task could plausibly relate but you can't tell. Bias toward "unsure" when uncertain; we fail open on unsure.`;

    const TIMEOUT_MS = 8000;
    const RACE_SENTINEL = Symbol("intent-gate-timeout");
    const wallclock = new Promise<typeof RACE_SENTINEL>(r => setTimeout(() => r(RACE_SENTINEL), TIMEOUT_MS));

    let providerCall: Promise<string | null>;
    if (resolved.provider === "anthropic") {
      const { streamForResponse_anthropic } = await import("../memory/curate-classifier.js");
      providerCall = streamForResponse_anthropic(resolved.apiKey, resolved.model, prompt);
    } else if (resolved.provider === "codex" || resolved.provider === "openai") {
      const { streamForResponse_codex } = await import("../memory/curate-classifier.js");
      providerCall = streamForResponse_codex(resolved.apiKey, resolved.model, prompt);
    } else {
      return null;
    }

    const raced = await Promise.race([providerCall, wallclock]);
    if (raced === RACE_SENTINEL) {
      providerCall.catch(() => {});
      return null;
    }
    const text = String(raced || "").trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      const parsed = JSON.parse(m[0]) as { verdict?: string; reason?: string };
      const v = parsed.verdict;
      if (v !== "match" && v !== "mismatch" && v !== "unsure") return null;
      return { verdict: v, reason: String(parsed.reason || "").slice(0, 200) };
    } catch { return null; }
  } catch { return null; }
}
