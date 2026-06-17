// Opus <-> PCM codec + linear resampler for the WebRTC voice transport.
//
// werift hands us Opus RTP payloads, but the STT engine needs raw 16kHz Int16
// PCM and TTS hands us Int16 PCM we must ship as Opus. This module bridges the
// two using a PURE-WASM Opus codec — deliberately NO native node-gyp addon, to
// keep the werift voice path free of a native build toolchain (the same "zero
// native build" property peer.ts relies on for werift).
//
// @evan/opus's root entry (lib.js) prefers a prebuilt native `.node` addon and
// only falls back to wasm on load failure — except it honors OPUS_FORCE_WASM,
// which pins it to the WebAssembly backend. We set that flag immediately before
// the dependency first evaluates (inside the cached loader, below) so no native
// `.node` is ever loaded — only wasm/index.js + opus.wasm. Verified: with the
// flag set, require.cache contains lib.js + wasm/index.js and zero *.node. We
// import the typed root specifier (its lib.d.ts) rather than the untyped wasm
// subpath so the codec stays fully typed with no `as any`.
//
// Frames are standard WebRTC Opus: 48kHz, mono, 20ms = 960 samples/frame.

import { createLogger } from "../logger.js";

const logger = createLogger("voice.opus-codec");

/** 48kHz mono Opus, 20ms frame. */
export const OPUS_SAMPLE_RATE = 48000;
export const OPUS_CHANNELS = 1;
export const OPUS_FRAME_SAMPLES = 960; // 20ms @ 48kHz

// ---------------------------------------------------------------------------
// Lazy wasm load (mirrors peer.ts loadWerift): a missing/broken optional dep
// must degrade just the voice-over-WebRTC feature, never crash boot. opus-codec
// can sit on an import chain reachable at startup, so a static `import` of the
// wasm lib would turn an absent dep into a fatal ERR_MODULE_NOT_FOUND. With the
// cached dynamic import, the call site awaits createOpus*() and handles the
// rejection locally.
//
// The package's lib.d.ts types the root specifier's Decoder/Encoder (decode/
// encode + the CTL surface) but NOT their inherited `drop()` cleanup. We add
// `drop()` via a local structural type so cleanup is typed without `as any`.
// ---------------------------------------------------------------------------

// Type-only import of the dependency's own declarations (erased at runtime, so
// it carries no module-graph cost and doesn't defeat the lazy load below).
import type { Decoder, Encoder } from "@evan/opus";

/** The dep's Decoder plus its (undeclared) wasm cleanup method. */
type WasmDecoder = Decoder & { drop(): void };
/** The dep's Encoder plus its (undeclared) wasm cleanup method. */
type WasmEncoder = Encoder & { drop(): void };

type OpusModule = typeof import("@evan/opus");

let _opusPromise: Promise<OpusModule> | null = null;

function loadOpusWasm(): Promise<OpusModule> {
  // Pin @evan/opus to its WebAssembly backend BEFORE the dependency first
  // evaluates. lib.js reads this env at module-eval time; setting it here — once,
  // immediately ahead of the cached dynamic import — guarantees no native `.node`
  // addon is ever required (the whole reason this path exists: zero native build).
  return (_opusPromise ??= (() => {
    process.env.OPUS_FORCE_WASM = "1";
    return import("@evan/opus");
  })());
}

// ---------------------------------------------------------------------------
// Public codec surface
// ---------------------------------------------------------------------------

/** Decodes 48kHz mono Opus packets to 960-sample Int16 frames. */
export interface OpusDecoder {
  decode(opusPacket: Uint8Array): Int16Array;
  free(): void;
}

/** Encodes 960-sample (20ms) 48kHz mono Int16 frames to Opus packets. */
export interface OpusEncoder {
  encode(pcm48kMono: Int16Array): Uint8Array;
  /**
   * True iff the most recent encode() produced a DTX (discontinuous
   * transmission) frame — i.e. libopus decided this 20ms of audio is silence
   * and the caller should transmit nothing for it. Reflects OPUS_GET_IN_DTX of
   * the last frame; meaningful only when dtx was enabled at creation.
   */
  wasDtx(): boolean;
  free(): void;
}

/**
 * Resilience controls for the outbound speech encoder. Every field is optional;
 * omitted fields fall back to the speech-tuned defaults in
 * {@link DEFAULT_ENCODER_OPTIONS}. All are applied via @evan/opus's typed
 * setters (which wrap the libopus encoder CTLs); none use a raw ctl() call.
 */
export interface OpusEncoderOptions {
  /** Target bitrate in bits/sec (OPUS_SET_BITRATE). Speech default 24000. */
  bitrate?: number;
  /** Inband forward error correction (OPUS_SET_INBAND_FEC). Default true. */
  inbandFec?: boolean;
  /** Discontinuous transmission during silence (OPUS_SET_DTX). Default true. */
  dtx?: boolean;
  /** Expected packet loss %, tunes FEC strength (OPUS_SET_PACKET_LOSS_PERC). Default 10. */
  packetLossPerc?: number;
  /** Encoder complexity 0–10 (OPUS_SET_COMPLEXITY). Omitted → lib default. */
  complexity?: number;
}

/** Speech-tuned defaults applied when an option is omitted. */
export const DEFAULT_ENCODER_OPTIONS: Required<
  Pick<OpusEncoderOptions, "bitrate" | "inbandFec" | "dtx" | "packetLossPerc">
> = {
  bitrate: 24000,
  inbandFec: true,
  dtx: true,
  packetLossPerc: 10,
};

/** A new 48kHz mono Opus decoder. Output PCM is 48kHz mono Int16. */
export async function createOpusDecoder(): Promise<OpusDecoder> {
  const opus = await loadOpusWasm();
  // The instance has drop() at runtime (inherited from the wasm class); the
  // dep's .d.ts just omits it. Assert the extended type — a widening of the
  // declared Decoder, not an `any` escape hatch.
  const dec = new opus.Decoder({
    channels: OPUS_CHANNELS,
    sample_rate: OPUS_SAMPLE_RATE,
  }) as WasmDecoder;
  logger.info("opus decoder ready (wasm, 48kHz mono)");

  return {
    decode(opusPacket: Uint8Array): Int16Array {
      // wasm decode() returns a fresh Uint8Array of interleaved Int16 LE bytes.
      // Re-view (not copy) as Int16; the slice it returns owns its buffer, so
      // the view is safe to hand on. byteLength is always even (2 B/sample).
      const bytes = dec.decode(opusPacket);
      return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    },
    free(): void {
      dec.drop();
    },
  };
}

/**
 * A new 48kHz mono Opus encoder, application=voip (best for speech, low delay).
 * Expects 960-sample (20ms) frames; other lengths are still valid Opus frame
 * sizes (2.5–60ms) but the WebRTC transport always feeds 20ms.
 *
 * `opts` tunes the encoder for resilient real-time speech (bitrate, inband FEC,
 * DTX, expected packet loss, complexity). Each control is applied through
 * @evan/opus's typed setters — thin wrappers over the libopus encoder CTLs — and
 * read back to confirm it took, so an unsupported control degrades to a logged
 * skip rather than a throw. Omitted fields use {@link DEFAULT_ENCODER_OPTIONS}.
 */
export async function createOpusEncoder(
  opts: OpusEncoderOptions = {},
): Promise<OpusEncoder> {
  const opus = await loadOpusWasm();
  const enc = new opus.Encoder({
    channels: OPUS_CHANNELS,
    sample_rate: OPUS_SAMPLE_RATE,
    application: "voip",
  }) as WasmEncoder;

  const bitrate = opts.bitrate ?? DEFAULT_ENCODER_OPTIONS.bitrate;
  const inbandFec = opts.inbandFec ?? DEFAULT_ENCODER_OPTIONS.inbandFec;
  const dtx = opts.dtx ?? DEFAULT_ENCODER_OPTIONS.dtx;
  const packetLossPerc = opts.packetLossPerc ?? DEFAULT_ENCODER_OPTIONS.packetLossPerc;

  // Apply each control and verify via the matching getter. A control that
  // didn't take (lib build without it, out-of-range value clamped away) is
  // reported, never thrown — partial resilience still beats failing the encoder.
  const applied: string[] = [];
  const skipped: string[] = [];
  applyControl(applied, skipped, "bitrate", bitrate, () => (enc.bitrate = bitrate), () => enc.bitrate === bitrate);
  applyControl(applied, skipped, "inbandFec", inbandFec, () => (enc.inband_fec = inbandFec), () => enc.inband_fec === inbandFec);
  applyControl(applied, skipped, "dtx", dtx, () => (enc.dtx = dtx), () => enc.dtx === dtx);
  applyControl(applied, skipped, "packetLossPerc", packetLossPerc, () => (enc.packet_loss = packetLossPerc), () => enc.packet_loss === packetLossPerc);
  if (opts.complexity !== undefined) {
    const cx = opts.complexity;
    applyControl(applied, skipped, "complexity", cx, () => (enc.complexity = clampComplexity(cx)), () => enc.complexity === clampComplexity(cx));
  }

  logger.info(
    `opus encoder ready (wasm, 48kHz mono, voip); applied=[${applied.join(",")}]` +
      (skipped.length ? ` skipped=[${skipped.join(",")}]` : ""),
  );

  return {
    encode(pcm48kMono: Int16Array): Uint8Array {
      // The wasm encoder reads the view as raw bytes and infers the sample
      // count from byteLength (length / 2 / channels). Pass a byte view that
      // exactly spans this frame so a pooled/over-allocated Int16Array can't
      // leak trailing samples into the packet.
      const bytes = new Uint8Array(
        pcm48kMono.buffer,
        pcm48kMono.byteOffset,
        pcm48kMono.byteLength,
      );
      return enc.encode(bytes);
    },
    wasDtx(): boolean {
      // OPUS_GET_IN_DTX reflects whether the most recent encode emitted a DTX
      // (no-transmission) frame. When dtx wasn't enabled this is always false.
      return enc.in_dtx;
    },
    free(): void {
      enc.drop();
    },
  };
}

/** Opus complexity is 0–10; clamp so an out-of-range request can't throw. */
function clampComplexity(c: number): 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 {
  const v = Math.max(0, Math.min(10, Math.round(c)));
  // The rounded clamp is provably one of the literal values the lib's typed
  // setter accepts; narrow without an `any` escape.
  return v as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
}

/**
 * Set one encoder control and confirm it stuck via its getter. A setter that
 * throws (control absent in this libopus build) or a value that doesn't read
 * back is recorded as skipped — the encoder stays usable either way.
 */
function applyControl(
  applied: string[],
  skipped: string[],
  name: string,
  value: number | boolean,
  set: () => void,
  verify: () => boolean,
): void {
  try {
    set();
    if (verify()) applied.push(name);
    else skipped.push(`${name}(unverified)`);
  } catch (e) {
    skipped.push(`${name}(${(e as Error).message})`);
  }
}

// ---------------------------------------------------------------------------
// Resampler
// ---------------------------------------------------------------------------

/**
 * Linear-interpolation resample of mono Int16 PCM between sample rates.
 *
 * Equal rates short-circuit to a copy. For each output index we map to the
 * fractional source position, lerp the two bracketing input samples, and clamp
 * to Int16 range. This is the same cheap, allocation-light approach the mobile
 * side uses; it is not a polyphase/anti-aliased resampler, but it is more than
 * adequate for 16k<->48k speech in the voice pipeline.
 */
export function resampleInt16(
  input: Int16Array,
  fromRate: number,
  toRate: number,
): Int16Array {
  if (!Number.isFinite(fromRate) || fromRate <= 0) {
    throw new Error(`resampleInt16: invalid fromRate ${fromRate}`);
  }
  if (!Number.isFinite(toRate) || toRate <= 0) {
    throw new Error(`resampleInt16: invalid toRate ${toRate}`);
  }
  if (fromRate === toRate) return input.slice();
  if (input.length === 0) return new Int16Array(0);
  if (input.length === 1) return new Int16Array([input[0]]);

  const ratio = toRate / fromRate;
  const outLength = Math.max(1, Math.round(input.length * ratio));
  const out = new Int16Array(outLength);
  const lastSrc = input.length - 1;

  for (let i = 0; i < outLength; i++) {
    // Map output index to fractional source position.
    const srcPos = i / ratio;
    let i0 = Math.floor(srcPos);
    if (i0 >= lastSrc) {
      // At/after the final sample — clamp to the last value (no neighbor).
      out[i] = input[lastSrc];
      continue;
    }
    const frac = srcPos - i0;
    const a = input[i0];
    const b = input[i0 + 1];
    const lerp = a + (b - a) * frac;
    out[i] = clampInt16(lerp);
  }

  return out;
}

function clampInt16(v: number): number {
  // Round, then clamp into [-32768, 32767].
  const r = v < 0 ? Math.ceil(v - 0.5) : Math.floor(v + 0.5);
  if (r > 32767) return 32767;
  if (r < -32768) return -32768;
  return r;
}
