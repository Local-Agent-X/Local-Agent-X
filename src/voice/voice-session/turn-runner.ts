// Canonical voice-turn state machine. Both the in-process (Tier-4 / CPU)
// session factory and the GPU (Python sidecar) factory drive this one machine
// instead of carrying their own drifting copies. It owns the per-turn
// lifecycle:
//
//   final transcript → agent_start → runTurn (LLM) → stream deltas to a
//   pluggable speaker → assistant_done / assistant_interrupted → playback-
//   completion bookkeeping (barge-in stays live until the browser ring drains)
//
// Engine specifics are injected so they can't fork again:
//   - TurnSpeaker  — turns streamed text into audio. In-process speaks whole
//                    sentences; the GPU path clause-splits + early-flushes.
//   - cancelTts    — stop in-flight synthesis on barge-in.
// The drain signal differs too (in-process: one onIdle; GPU: per-chunk
// audio_done countdown), so each session calls markTtsDrained() when its
// engine reports the TTS queue empty, and the machine schedules the real
// end-of-playback from the samples-shipped estimator.

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { VoiceSessionContext } from "../audio-ws.js";
import type { VoiceTurnRunner } from "./types.js";

export const SENTENCE_TERMINATOR = /[.!?]["')\]]?(?=\s|$)/;

/** Earliest cut point for the OPENING TTS chunk, so the voice starts reading
 *  while the reply is still streaming instead of trailing it — the dominant
 *  felt-latency lever for slow synthesis (clone voices). Returns the slice end
 *  at the first clause break (≥4 chars in) or a word boundary (≥`minChars`),
 *  or -1 when there's not enough yet. Engine speakers call this once per turn
 *  for the first chunk, then fall back to sentence/clause flushing for the
 *  bulk (which has better prosody). */
export function firstChunkCut(buf: string, minChars = 12): number {
  const clause = /[,;:]\s+/.exec(buf);
  if (clause && clause.index >= 4) return clause.index + clause[0].length;
  if (buf.length >= minChars) {
    const space = buf.indexOf(" ", minChars);
    if (space > 0) return space + 1;
  }
  return -1;
}

const PLAYBACK_TAIL_MS = 250; // grace for browser scheduler / network jitter

interface TurnLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

/** Engine-specific text→TTS pipeline. The machine feeds it streamed deltas
 *  and a final flush; the speaker decides sentence/clause boundaries, pushes
 *  audio to its engine, and tracks whether anything was queued this turn. */
export interface TurnSpeaker {
  /** Reset per-turn buffer + queued state (called at agent_start). */
  reset(): void;
  /** Append a streamed delta; flush completed sentences/clauses to TTS. */
  feed(delta: string): void;
  /** Stream ended cleanly — flush whatever text remains. */
  flushTail(): void;
  /** Did this turn push at least one chunk to TTS? Drives whether the machine
   *  waits for a drain signal or closes the turn immediately. */
  hasQueued(): boolean;
  /** Live count of TTS chunks still synthesizing, when the engine can report
   *  it (GPU). Lets the machine finalize a short reply whose audio drained
   *  before the LLM finished. Omit when the engine has no live count. */
  pendingCount?(): number;
}

export interface VoiceTurnMachineDeps {
  ctx: VoiceSessionContext;
  runTurn: VoiceTurnRunner;
  speaker: TurnSpeaker;
  /** Cancel in-flight TTS on barge-in (tts.cancel / bridge.cancelTTS). */
  cancelTts: () => void;
  isClosed: () => boolean;
  logger: TurnLogger;
}

export interface VoiceTurnMachine {
  /** Run a turn from an authoritative final transcript. `sttMs` (when the
   *  engine measured it) rides along on the `final` event + timing log. */
  handleFinalTranscript(rawText: string, sttMs?: number): Promise<void>;
  /** Barge-in: user spoke during an active reply. No-op when idle. */
  interrupt(): void;
  /** Engine shipped a TTS audio chunk of `ms` playback duration to the browser. */
  noteAudioShipped(ms: number): void;
  /** Engine's TTS queue drained (in-process onIdle / GPU last audio_done). */
  markTtsDrained(): void;
  /** Tear down on session close. */
  close(): void;
}

export function createVoiceTurnMachine(deps: VoiceTurnMachineDeps): VoiceTurnMachine {
  const { ctx, runTurn, speaker, cancelTts, isClosed, logger } = deps;
  const sid = ctx.sessionId;

  let activeTurn: AbortController | null = null;
  let llmDone = false;
  let history: ChatCompletionMessageParam[] = [];

  // Playback-completion estimator. The engine's drain signal fires when it
  // STOPS synthesizing, but the browser ring still holds 1-3s of buffered
  // audio; clearing activeTurn then would kill barge-in mid-playback. Track
  // samples-shipped to schedule the real end-of-playback.
  let expectedPlaybackEndMs = 0;
  let pendingClearTimer: ReturnType<typeof setTimeout> | null = null;

  // Per-turn timing (relative to agent_start) for the [timing] seam log.
  let turnStartTs = 0;
  let ttftMs = 0;
  let firstAudioMs = 0;

  function clearTimer(): void {
    if (pendingClearTimer) { clearTimeout(pendingClearTimer); pendingClearTimer = null; }
  }

  function finishTurn(): void {
    activeTurn = null;
    llmDone = false;
    expectedPlaybackEndMs = 0;
  }

  function interrupt(): void {
    if (isClosed() || !activeTurn) return;
    logger.info(`[turn] ${sid}: barge-in → interrupting agent`);
    clearTimer();
    try { activeTurn.abort(); } catch { /* already settled */ }
    try { cancelTts(); } catch { /* engine already idle */ }
    ctx.sendEvent({ type: "tts_interrupt" });
    finishTurn();
  }

  function noteAudioShipped(ms: number): void {
    const now = Date.now();
    expectedPlaybackEndMs = Math.max(now, expectedPlaybackEndMs) + ms;
    if (activeTurn && firstAudioMs === 0) firstAudioMs = now - turnStartTs;
  }

  function markTtsDrained(): void {
    if (isClosed() || !llmDone || !activeTurn) return;
    ctx.sendEvent({ type: "tts_idle" });
    clearTimer();
    const delay = Math.max(0, expectedPlaybackEndMs - Date.now() + PLAYBACK_TAIL_MS);
    pendingClearTimer = setTimeout(() => {
      pendingClearTimer = null;
      if (activeTurn && !isClosed()) {
        finishTurn();
        ctx.sendEvent({ type: "playback_complete" });
      }
    }, delay);
  }

  async function handleFinalTranscript(rawText: string, sttMs?: number): Promise<void> {
    if (isClosed()) return;
    const utterance = rawText.trim();
    if (!utterance) return;
    if (activeTurn) {
      logger.info(`[turn] ${sid}: ignoring final while turn in progress: "${utterance.slice(0, 40)}"`);
      return;
    }

    ctx.sendEvent(sttMs != null ? { type: "final", text: utterance, sttMs } : { type: "final", text: utterance });

    // Dictate mode: transcript already delivered via `final`; the client routes
    // it into the textarea. Skip agent_start / runTurn / TTS entirely.
    if (ctx.mode === "dictate") {
      logger.info(`[turn] ${sid}: dictate final, skipping agent/TTS`);
      return;
    }

    ctx.sendEvent({ type: "agent_start" });
    // Capture the controller locally. interrupt() aborts it AND nulls the
    // shared `activeTurn` synchronously, so checking `activeTurn?.signal` after
    // the await would read null and misroute an interrupted turn into the
    // success branch — the latent bug in both original forks. The captured
    // `turn` still reports aborted regardless of what `activeTurn` points at.
    const turn = new AbortController();
    activeTurn = turn;
    llmDone = false;
    turnStartTs = Date.now();
    ttftMs = 0;
    firstAudioMs = 0;
    speaker.reset();

    try {
      const result = await runTurn({
        text: utterance,
        history,
        sessionId: sid,
        signal: turn.signal,
        onDelta: (delta) => {
          if (isClosed() || turn.signal.aborted || !delta) return;
          if (ttftMs === 0) ttftMs = Date.now() - turnStartTs;
          ctx.sendEvent({ type: "assistant_delta", text: delta });
          speaker.feed(delta);
        },
        onVisual: (kind, value, durationMs) => {
          if (isClosed()) return;
          ctx.sendEvent({ type: "visual", kind, value, durationMs });
        },
      });

      if (turn.signal.aborted) {
        // Barge-in landed mid-turn. runTurn returns updatedHistory with an
        // "[interrupted by user]" marker so the next turn keeps the record.
        history = result.updatedHistory;
        ctx.sendEvent({ type: "assistant_interrupted" });
        if (activeTurn === turn) activeTurn = null;
        return;
      }

      speaker.flushTail();
      history = result.updatedHistory;
      ctx.sendEvent({ type: "assistant_done", text: result.assistantText });
      logger.info(`[timing] ${sid} stt=${sttMs ?? "?"}ms ttft=${ttftMs}ms firstAudio=${firstAudioMs || "pending"}ms llm=${Date.now() - turnStartTs}ms`);

      if (!speaker.hasQueued()) {
        // Empty/short reply queued no audio → no drain signal is coming. Emit
        // the terminal events now so the client resets (canonical behavior —
        // the GPU path already did this; the in-process path used to just null
        // activeTurn, leaving the client without a playback_complete).
        ctx.sendEvent({ type: "tts_idle" });
        ctx.sendEvent({ type: "playback_complete" });
        finishTurn();
        return;
      }

      // Hold activeTurn so barge-in stays live until playback drains.
      llmDone = true;
      // If the engine can see its queue already emptied (short reply whose TTS
      // outpaced the LLM), finalize now instead of waiting for a drain signal
      // that already fired.
      if (speaker.pendingCount && speaker.pendingCount() === 0) markTtsDrained();
    } catch (e) {
      const msg = (e as Error).message || String(e);
      if (turn.signal.aborted) {
        logger.info(`[turn] ${sid}: turn aborted (barge-in)`);
        ctx.sendEvent({ type: "assistant_interrupted" });
      } else {
        logger.warn(`[turn] ${sid}: turn failed: ${msg}`);
        ctx.sendEvent({ type: "agent_error", message: msg });
      }
      if (activeTurn === turn) activeTurn = null;
    }
  }

  function close(): void {
    clearTimer();
    try { activeTurn?.abort(); } catch { /* already settled */ }
    activeTurn = null;
  }

  return { handleFinalTranscript, interrupt, noteAudioShipped, markTtsDrained, close };
}
