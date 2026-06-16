// Pure signaling state machine for the DESKTOP (offerer) side of a live-screen
// session. Mirrors the phone's machine (answerer) but inverted: the desktop emits
// the offer and consumes the answer.
//
// Pure + total: `(state, action) -> { state, effects }`. No I/O — the session
// manager interprets the effects (start capture, create/feed the peer, send
// frames over the chat socket). This is what makes the ordering exhaustively
// unit-testable without ffmpeg or a real peer (deliverable §3).
//
// States (constitution / prompt: idle → offering → connecting → live →
// closed/failed):
//   idle        — no session.
//   offering     — rtc_start received; capture + peer building, offer being created.
//   connecting   — offer sent, answer/ICE exchange in progress (not yet connected).
//   live         — peer connected; media flowing.
//   closed       — torn down cleanly (rtc_stop / disconnect / revoke).
//   failed       — peer/capture failed; carries actionable text.
//
// Stray frames (an answer before we offered, ICE after close, a second start for
// a live session) are IGNORED, not crashed on — exactly the robustness the live
// media path needs.

export type SignalingState =
  | "idle"
  | "offering"
  | "connecting"
  | "live"
  | "closed"
  | "failed";

/** Inputs the machine folds (control + peer lifecycle). */
export type SignalingAction =
  /** Phone asked to begin (rtc_start). */
  | { kind: "start"; rtcId: string }
  /** Our offer SDP was produced by the peer. */
  | { kind: "offerReady"; rtcId: string; sdp: string }
  /** Phone's answer arrived (rtc_answer). */
  | { kind: "answer"; rtcId: string; sdp: string }
  /** A trickled ICE candidate arrived from the phone (rtc_ice). */
  | { kind: "remoteIce"; rtcId: string }
  /** Our peer produced a local ICE candidate to trickle to the phone. */
  | { kind: "localIce"; rtcId: string }
  /** The peer's connection state changed. */
  | { kind: "peerState"; rtcId: string; connection: PeerConnectionState }
  /** Phone asked to stop (rtc_stop). */
  | { kind: "stop"; rtcId: string }
  /** The underlying socket / device dropped (disconnect or revoke). */
  | { kind: "disconnect" }
  /** A capture/peer error surfaced (carries actionable text). */
  | { kind: "fail"; rtcId: string; message: string };

/** The subset of RTCPeerConnection states we react to (werift + browser union). */
export type PeerConnectionState =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";

/** Side-effects the manager performs (no I/O in the fold). */
export type SignalingEffect =
  /** Begin ffmpeg capture + build the peer + create the offer. */
  | { kind: "startCapture"; rtcId: string; monitor?: number }
  /** Send our offer SDP to the phone (rtc_offer). */
  | { kind: "sendOffer"; rtcId: string; sdp: string }
  /** Apply the phone's answer to the peer. */
  | { kind: "applyAnswer"; rtcId: string; sdp: string }
  /** Send a queued local ICE candidate to the phone. */
  | { kind: "flushLocalIce"; rtcId: string }
  /** Apply the phone's trickled ICE candidate to the peer. */
  | { kind: "applyRemoteIce"; rtcId: string }
  /** Tear everything down (stop ffmpeg, close peer). */
  | { kind: "teardown"; rtcId: string }
  /** Notify the phone the session is closing (rtc_closed). */
  | { kind: "notifyClosed"; rtcId: string; reason: string }
  /** Surface an actionable error to the phone (rtc_error). */
  | { kind: "notifyError"; rtcId: string; message: string };

export interface SignalingMachine {
  status: SignalingState;
  /** Active session id, or null when idle/closed. */
  rtcId: string | null;
  /** Actionable text when status === "failed". */
  error: string | null;
}

export interface SignalingTransition {
  state: SignalingMachine;
  effects: SignalingEffect[];
}

export const initialSignaling: SignalingMachine = {
  status: "idle",
  rtcId: null,
  error: null,
};

function next(
  state: SignalingMachine,
  patch: Partial<SignalingMachine>,
  effects: SignalingEffect[] = [],
): SignalingTransition {
  return { state: { ...state, ...patch }, effects };
}

/** True when an action's rtcId belongs to the active session (stray-frame guard). */
function isCurrent(state: SignalingMachine, rtcId: string): boolean {
  return state.rtcId !== null && state.rtcId === rtcId;
}

/** Terminal states ignore everything except a fresh `start`. */
function isTerminal(status: SignalingState): boolean {
  return status === "closed" || status === "failed" || status === "idle";
}

export function signalingReducer(
  state: SignalingMachine,
  action: SignalingAction,
): SignalingTransition {
  switch (action.kind) {
    case "start": {
      // A start while a session is already live/connecting is a stray duplicate —
      // ignore it (the phone should rtc_stop first). Only start from a resting
      // state (idle / closed / failed).
      if (!isTerminal(state.status)) return next(state, {});
      return next(
        { status: "offering", rtcId: action.rtcId, error: null },
        {},
        [{ kind: "startCapture", rtcId: action.rtcId }],
      );
    }

    case "offerReady": {
      if (!isCurrent(state, action.rtcId) || state.status !== "offering") {
        return next(state, {}); // stray / late offer — drop
      }
      return next(state, { status: "connecting" }, [
        { kind: "sendOffer", rtcId: action.rtcId, sdp: action.sdp },
      ]);
    }

    case "answer": {
      // Accept the answer only while we're awaiting one (connecting). An answer
      // in any other state is stray.
      if (!isCurrent(state, action.rtcId) || state.status !== "connecting") {
        return next(state, {});
      }
      return next(state, {}, [{ kind: "applyAnswer", rtcId: action.rtcId, sdp: action.sdp }]);
    }

    case "remoteIce": {
      // Trickle ICE is valid from connecting onward (and harmless once live).
      if (!isCurrent(state, action.rtcId)) return next(state, {});
      if (state.status !== "connecting" && state.status !== "live") return next(state, {});
      return next(state, {}, [{ kind: "applyRemoteIce", rtcId: action.rtcId }]);
    }

    case "localIce": {
      if (!isCurrent(state, action.rtcId)) return next(state, {});
      if (isTerminal(state.status)) return next(state, {});
      return next(state, {}, [{ kind: "flushLocalIce", rtcId: action.rtcId }]);
    }

    case "peerState": {
      if (!isCurrent(state, action.rtcId)) return next(state, {});
      switch (action.connection) {
        case "connected":
          // First connection flips us live; an already-live reconfirm is a no-op.
          return state.status === "live"
            ? next(state, {})
            : next(state, { status: "live" });
        case "failed":
          if (isTerminal(state.status)) return next(state, {});
          return next(state, { status: "failed", error: "Live-screen connection failed." }, [
            { kind: "teardown", rtcId: action.rtcId },
            { kind: "notifyError", rtcId: action.rtcId, message: "Live-screen connection failed." },
          ]);
        case "closed":
        case "disconnected":
          // A disconnected peer (transient on ICE) only ends a LIVE session; while
          // still connecting we keep waiting for ICE to recover.
          if (state.status !== "live") return next(state, {});
          return next(state, { status: "closed", rtcId: null }, [
            { kind: "teardown", rtcId: action.rtcId },
            { kind: "notifyClosed", rtcId: action.rtcId, reason: "Peer disconnected." },
          ]);
        default:
          return next(state, {});
      }
    }

    case "stop": {
      if (!isCurrent(state, action.rtcId) || isTerminal(state.status)) {
        return next(state, {});
      }
      return next(state, { status: "closed", rtcId: null }, [
        { kind: "teardown", rtcId: action.rtcId },
        { kind: "notifyClosed", rtcId: action.rtcId, reason: "Stopped by user." },
      ]);
    }

    case "disconnect": {
      // Socket/device dropped (incl. revoke). Tear down any active session.
      if (state.rtcId === null || isTerminal(state.status)) {
        return next({ status: "closed", rtcId: null, error: null }, {});
      }
      const rtcId = state.rtcId;
      return next({ status: "closed", rtcId: null, error: null }, {}, [
        { kind: "teardown", rtcId },
      ]);
    }

    case "fail": {
      if (!isCurrent(state, action.rtcId) || isTerminal(state.status)) {
        return next(state, {});
      }
      return next(state, { status: "failed", error: action.message }, [
        { kind: "teardown", rtcId: action.rtcId },
        { kind: "notifyError", rtcId: action.rtcId, message: action.message },
      ]);
    }

    default: {
      const _exhaustive: never = action;
      return next(state, {});
    }
  }
}
