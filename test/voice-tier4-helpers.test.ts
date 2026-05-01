import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  KOKORO_VOICES,
  isValidKokoroVoice,
  kokoroVoiceMeta,
  kokoroVoiceList,
} from "../src/voice/tier4/kokoro-voices.js";
import {
  envDevice,
  envDtype,
  envVoice,
  envSpeed,
  SPEED_MIN,
  SPEED_MAX,
  VALID_DEVICES,
  VALID_DTYPES,
} from "../src/voice/tier4/env.js";

const TIER4_ENV_KEYS = [
  "LAX_VOICE_TIER4_DEVICE",
  "LAX_VOICE_TIER4_DTYPE",
  "LAX_VOICE_TIER4_VOICE",
  "LAX_VOICE_TIER4_SPEED",
  "LAX_VOICE_DEBUG",
];

describe("KOKORO_VOICES set", () => {
  it("is a non-empty ReadonlySet", () => {
    expect(KOKORO_VOICES.size).toBeGreaterThan(40);
  });

  it("contains the documented default voice (am_michael)", () => {
    expect(KOKORO_VOICES.has("am_michael")).toBe(true);
  });

  it("contains a sampling of well-known voices across languages", () => {
    for (const id of ["af_bella", "bf_emma", "ef_dora", "jf_alpha", "zf_xiaobei"]) {
      expect(KOKORO_VOICES.has(id)).toBe(true);
    }
  });

  it("does not contain typo-style invalid IDs", () => {
    expect(KOKORO_VOICES.has("am_michale")).toBe(false);
    expect(KOKORO_VOICES.has("AM_MICHAEL")).toBe(false);
    expect(KOKORO_VOICES.has("")).toBe(false);
  });
});

describe("isValidKokoroVoice", () => {
  it("returns true for known voices", () => {
    expect(isValidKokoroVoice("am_michael")).toBe(true);
    expect(isValidKokoroVoice("af_bella")).toBe(true);
  });

  it("returns false for unknown / typo / wrong-case", () => {
    expect(isValidKokoroVoice("nope")).toBe(false);
    expect(isValidKokoroVoice("AM_MICHAEL")).toBe(false);
    expect(isValidKokoroVoice("am_micheal")).toBe(false);
  });

  it("returns false for null / undefined / empty / non-string", () => {
    expect(isValidKokoroVoice(null)).toBe(false);
    expect(isValidKokoroVoice(undefined)).toBe(false);
    expect(isValidKokoroVoice("")).toBe(false);
    // Non-string at runtime should still return false (defense-in-depth).
    expect(isValidKokoroVoice(123 as unknown as string)).toBe(false);
  });
});

describe("kokoroVoiceMeta", () => {
  it("infers en-US + male for am_michael", () => {
    const m = kokoroVoiceMeta("am_michael");
    expect(m).toEqual({ id: "am_michael", language: "en-US", gender: "male", name: "michael" });
  });

  it("infers en-GB + female for bf_emma", () => {
    const m = kokoroVoiceMeta("bf_emma");
    expect(m.language).toBe("en-GB");
    expect(m.gender).toBe("female");
    expect(m.name).toBe("emma");
  });

  it("maps every documented language prefix correctly", () => {
    const cases: Array<[string, string]> = [
      ["af_alloy", "en-US"],
      ["bm_daniel", "en-GB"],
      ["ef_dora", "es"],
      ["ff_siwis", "fr"],
      ["hf_alpha", "hi"],
      ["if_sara", "it"],
      ["jf_alpha", "ja"],
      ["pf_dora", "pt-BR"],
      ["zf_xiaobei", "zh-CN"],
    ];
    for (const [id, lang] of cases) {
      expect(kokoroVoiceMeta(id).language).toBe(lang);
    }
  });

  it("falls back to 'other' for an unknown language letter", () => {
    expect(kokoroVoiceMeta("xf_unknown").language).toBe("other");
  });

  it("returns gender='unknown' when the second char is neither f nor m", () => {
    expect(kokoroVoiceMeta("ax_test").gender).toBe("unknown");
  });

  it("handles ids with no underscore (no name suffix)", () => {
    const m = kokoroVoiceMeta("af");
    expect(m.id).toBe("af");
    expect(m.name).toBe("");
    expect(m.language).toBe("en-US");
    expect(m.gender).toBe("female");
  });
});

describe("kokoroVoiceList", () => {
  it("returns one entry per voice in KOKORO_VOICES", () => {
    const list = kokoroVoiceList();
    expect(list.length).toBe(KOKORO_VOICES.size);
  });

  it("every entry resolves to a known language and a defined gender", () => {
    for (const meta of kokoroVoiceList()) {
      expect(typeof meta.id).toBe("string");
      expect(["female", "male", "unknown"]).toContain(meta.gender);
      expect(typeof meta.language).toBe("string");
      expect(meta.language.length).toBeGreaterThan(0);
    }
  });

  it("exposes the default voice (am_michael) somewhere in the list", () => {
    const ids = kokoroVoiceList().map((m) => m.id);
    expect(ids).toContain("am_michael");
  });
});

describe("env helpers — VALID_* sets and SPEED bounds", () => {
  it("VALID_DEVICES covers the documented options", () => {
    for (const d of ["cpu", "wasm", "webgpu", "dml", "cuda", "auto"]) {
      expect(VALID_DEVICES.has(d as never)).toBe(true);
    }
  });

  it("VALID_DTYPES covers the documented options", () => {
    for (const t of ["fp32", "fp16", "q8", "q4", "q4f16"]) {
      expect(VALID_DTYPES.has(t as never)).toBe(true);
    }
  });

  it("SPEED_MIN / SPEED_MAX match the kokoro-js recommended range", () => {
    expect(SPEED_MIN).toBe(0.5);
    expect(SPEED_MAX).toBe(2.0);
  });
});

describe("env parsers — happy + sad paths", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of TIER4_ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of TIER4_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("envDevice() returns undefined when unset", () => {
    expect(envDevice()).toBeUndefined();
  });

  it("envDevice() lowercases and validates", () => {
    process.env.LAX_VOICE_TIER4_DEVICE = "DML";
    expect(envDevice()).toBe("dml");
  });

  it("envDevice() drops unknown values", () => {
    process.env.LAX_VOICE_TIER4_DEVICE = "tpu";
    expect(envDevice()).toBeUndefined();
  });

  it("envDtype() validates against VALID_DTYPES", () => {
    process.env.LAX_VOICE_TIER4_DTYPE = "fp16";
    expect(envDtype()).toBe("fp16");
    process.env.LAX_VOICE_TIER4_DTYPE = "fp99";
    expect(envDtype()).toBeUndefined();
  });

  it("envVoice() returns the voice when valid", () => {
    process.env.LAX_VOICE_TIER4_VOICE = "af_bella";
    expect(envVoice()).toBe("af_bella");
  });

  it("envVoice() returns undefined for unknown voices (no throw)", () => {
    process.env.LAX_VOICE_TIER4_VOICE = "totally_made_up";
    expect(envVoice()).toBeUndefined();
  });

  it("envVoice() returns undefined for empty / whitespace", () => {
    process.env.LAX_VOICE_TIER4_VOICE = "   ";
    expect(envVoice()).toBeUndefined();
  });

  it("envSpeed() parses a valid in-range float", () => {
    process.env.LAX_VOICE_TIER4_SPEED = "1.2";
    expect(envSpeed()).toBe(1.2);
  });

  it("envSpeed() rejects out-of-range values (clamping is the caller's problem)", () => {
    process.env.LAX_VOICE_TIER4_SPEED = "0.1";
    expect(envSpeed()).toBeUndefined();
    process.env.LAX_VOICE_TIER4_SPEED = "5";
    expect(envSpeed()).toBeUndefined();
  });

  it("envSpeed() rejects non-numeric values", () => {
    process.env.LAX_VOICE_TIER4_SPEED = "fast";
    expect(envSpeed()).toBeUndefined();
  });

  it("envSpeed() accepts the boundary values exactly", () => {
    process.env.LAX_VOICE_TIER4_SPEED = String(SPEED_MIN);
    expect(envSpeed()).toBe(SPEED_MIN);
    process.env.LAX_VOICE_TIER4_SPEED = String(SPEED_MAX);
    expect(envSpeed()).toBe(SPEED_MAX);
  });
});
