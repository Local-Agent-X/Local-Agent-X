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
import { stripTranscriptNoise } from "../transcript-noise.js";

// Continuation merge: a barge-in that lands before the user heard more than
// this much of the reply almost always means "I wasn't done talking", not
// "new topic" — so the NEXT final continues the interrupted turn's utterance
// instead of standing alone (the model was answering only the last fragment).
const CONTINUATION_MAX_HEARD_MS = 2_500;
// The armed continuation expires if no follow-up final arrives in this window.
const CONTINUATION_WINDOW_MS = 30_000;

export const SENTENCE_TERMINATOR = /[.!?]["')\]]?(?=\s|$)/;

/** Earliest cut point for the OPENING TTS chunk, so the voice starts reading
 *  while the reply is still streaming instead of trailing it — the dominant
 *  felt-latency lever for slow synthesis (clone voices). Returns the slice end
 *  at the first clause break (≥`minClauseChars` in) or a word boundary
 *  (≥`minChars`), or -1 when there's not enough yet. Engine speakers call this
 *  once per turn for the first chunk, then fall back to sentence/clause flushing
 *  for the bulk (which has better prosody). `minClauseChars` lets an engine veto
 *  a too-tiny opener ("Sure,") whose audio drains before the next chunk can
 *  synthesize — a cadence gap on cloud/RTF~1 engines. */
export function firstChunkCut(buf: string, minChars = 12, minClauseChars = 4): number {
  const clause = /[,;:]\s+/.exec(buf);
  if (clause && clause.index >= minClauseChars) return clause.index + clause[0].length;
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
  /** Speak a server-initiated line (op finished / needs input). Speaks now if
   *  idle; otherwise queues and drains at the next turn boundary so it never
   *  cuts off a live reply or the user. */
  speakProactive(text: string): void;
  /** Tear down on session close. */
  close(): void;
}

export function createVoiceTurnMachine(deps: VoiceTurnMachineDeps): VoiceTurnMachine {
  const { ctx, runTurn, speaker, cancelTts, isClosed, logger } = deps;
  const sid = ctx.sessionId;

  let activeTurn: AbortController | null = null;
  let llmDone = false;
  let ttsDrained = false;
  let drainHandled = false;
  let history: ChatCompletionMessageParam[] = [];

  // Proactive utterances (a background op finished / needs input) queued for
  // the SERVER to speak on its own initiative. They never preempt a live turn:
  // if one is in flight they wait here and drain at the next turn boundary, so
  // the agent finishes what it's saying and the user is never cut off.
  const proactiveQueue: string[] = [];

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

  // Continuation merge state — see the constants at the top of this file.
  // `currentUtterance` is the (possibly already-merged) user text of the
  // active turn; `continuation` is armed by interrupt() when its reply was
  // cut before the user really heard it.
  let currentUtterance = "";
  let continuation: { text: string; at: number } | null = null;

  function clearTimer(): void {
    if (pendingClearTimer) { clearTimeout(pendingClearTimer); pendingClearTimer = null; }
  }

  function finishTurn(): void {
    activeTurn = null;
    llmDone = false;
    ttsDrained = false;
    drainHandled = false;
    expectedPlaybackEndMs = 0;
  }

  function interrupt(): void {
    if (isClosed() || !activeTurn) return;
    logger.info(`[turn] ${sid}: barge-in → interrupting agent`);
    // Heard-time: zero until first audio actually shipped, then wall-clock
    // since it started playing. A reply cut this early means the user was
    // continuing their thought — arm the merge for the next final.
    const heardMs = firstAudioMs === 0 ? 0 : Math.max(0, Date.now() - (turnStartTs + firstAudioMs));
    if (ctx.mode !== "dictate" && currentUtterance && heardMs < CONTINUATION_MAX_HEARD_MS) {
      continuation = { text: currentUtterance, at: Date.now() };
      logger.info(`[turn] ${sid}: continuation armed (heard ${heardMs}ms of reply)`);
    }
    clearTimer();
    try { activeTurn.abort(); } catch { /* already settled */ }
    try { cancelTts(); } catch { /* engine already idle */ }
    ctx.sendEvent({ type: "tts_interrupt" });
    finishTurn();
  }

  function noteAudioShipped(ms: number): void {
    const now = Date.now();
    expectedPlaybackEndMs = Math.max(now, expectedPlaybackEndMs) + ms;
    // Floor at 1: 0 is the "no audio yet" sentinel (both here and in the
    // [timing] log), and first audio landing in the same millisecond as turn
    // start must still count as shipped.
    if (activeTurn && firstAudioMs === 0) firstAudioMs = Math.max(1, now - turnStartTs);
  }

  function markTtsDrained(): void {
    if (isClosed() || !activeTurn) return;
    ttsDrained = true;
    if (!llmDone || drainHandled) return;
    drainHandled = true;
    ctx.sendEvent({ type: "tts_idle" });
    clearTimer();
    const delay = Math.max(0, expectedPlaybackEndMs - Date.now() + PLAYBACK_TAIL_MS);
    pendingClearTimer = setTimeout(() => {
      pendingClearTimer = null;
      if (activeTurn && !isClosed()) {
        finishTurn();
        ctx.sendEvent({ type: "playback_complete" });
        // Turn boundary reached — surface any queued proactive line now.
        tryDrainProactive();
      }
    }, delay);
  }

  // Speak a server-initiated line as a synthetic turn: same speaker, same
  // drain/barge-in machinery as a real reply (so the user can talk over it and
  // it can't corrupt a live turn's speaker buffer). Only entered when idle.
  function runProactiveTurn(text: string): void {
    ctx.sendEvent({ type: "agent_start" });
    const turn = new AbortController();
    // A proactive line is not an answer to a user utterance — interrupting it
    // must never arm a merge with a stale utterance from an earlier turn.
    currentUtterance = "";
    activeTurn = turn;
    llmDone = false;
    ttsDrained = false;
    drainHandled = false;
    turnStartTs = Date.now();
    ttftMs = 0;
    firstAudioMs = 0;
    speaker.reset();
    ctx.sendEvent({ type: "assistant_delta", text });
    speaker.feed(text);
    speaker.flushTail();
    ctx.sendEvent({ type: "assistant_done", text });
    if (!speaker.hasQueued()) {
      ctx.sendEvent({ type: "tts_idle" });
      ctx.sendEvent({ type: "playback_complete" });
      finishTurn();
      tryDrainProactive();
      return;
    }
    llmDone = true;
    if (ttsDrained || (speaker.pendingCount && speaker.pendingCount() === 0)) markTtsDrained();
  }

  function tryDrainProactive(): void {
    if (isClosed() || activeTurn || proactiveQueue.length === 0) return;
    const text = (proactiveQueue.shift() || "").trim();
    if (!text) { tryDrainProactive(); return; }
    logger.info(`[turn] ${sid}: proactive speak (${text.length} chars)`);
    runProactiveTurn(text);
  }

  /** Enqueue a line for the agent to speak proactively. Speaks now if idle,
   *  otherwise drains at the next turn boundary. No-op in dictate mode (no
   *  agent TTS there) or once closed. */
  function speakProactive(text: string): void {
    if (isClosed() || ctx.mode === "dictate") return;
    const t = (text || "").trim();
    if (!t) return;
    proactiveQueue.push(t);
    tryDrainProactive();
  }

  async function handleFinalTranscript(rawText: string, sttMs?: number): Promise<void> {
    if (isClosed()) return;
    // Noise gate: Whisper hallucinates stage directions ("(muffled speaking",
    // "[BLANK_AUDIO]") on quiet or cut-off audio. Those must never become a
    // user turn — the agent would answer the garbage ("I didn't catch that")
    // instead of the user's actual words. An armed continuation survives a
    // dropped noise final and waits for the next real one.
    const utterance = stripTranscriptNoise(rawText);
    if (!utterance) {
      if (rawText.trim()) logger.info(`[turn] ${sid}: dropped noise-only final: "${rawText.trim().slice(0, 40)}"`);
      return;
    }
    if (activeTurn) {
      logger.info(`[turn] ${sid}: ignoring final while turn in progress: "${utterance.slice(0, 40)}"`);
      return;
    }

    // Continuation merge: this final arrived after a barge-in cut a reply the
    // user had barely heard — treat it as the same thought. The model turn
    // runs on the JOINED text; the client still shows just the new words.
    let continuationOf: string | undefined;
    if (continuation && Date.now() - continuation.at < CONTINUATION_WINDOW_MS) {
      continuationOf = continuation.text;
      logger.info(`[turn] ${sid}: continuing interrupted utterance (+"${utterance.slice(0, 40)}")`);
    }
    continuation = null;
    const turnText = continuationOf ? `${continuationOf} ${utterance}` : utterance;

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
    currentUtterance = turnText;
    llmDone = false;
    ttsDrained = false;
    drainHandled = false;
    turnStartTs = Date.now();
    ttftMs = 0;
    firstAudioMs = 0;
    speaker.reset();

    try {
      const result = await runTurn({
        text: turnText,
        continuationOf,
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
        // Barge-in landed mid-turn. runTurn returns updatedHistory whose last
        // assistant row carries `_interrupted: true` (rendered for the model
        // by providers/sanitize.ts) so the next turn keeps the record.
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
        tryDrainProactive();
        return;
      }

      // Hold activeTurn so barge-in stays live until playback drains.
      llmDone = true;
      // If the engine can see its queue already emptied (short reply whose TTS
      // outpaced the LLM), finalize now instead of waiting for a drain signal
      // that already fired.
      if (ttsDrained || (speaker.pendingCount && speaker.pendingCount() === 0)) markTtsDrained();
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

  return { handleFinalTranscript, interrupt, noteAudioShipped, markTtsDrained, speakProactive, close };
}
