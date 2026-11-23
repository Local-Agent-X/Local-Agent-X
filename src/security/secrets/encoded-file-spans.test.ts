// A file in base64 is not a guessed password; a key is, whatever is written in
// front of it. Measured 2026-11-22: a 3 KB PNG in a JSON body came back from
// the scan as 58 "High-Entropy Token" matches, each a fragment between two `/`.
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { encodedFileSpans } from "./encoded-file-spans.js";
import { scanForSecrets } from "./secret-scanner.js";
import { checkOutboundPayload } from "../../tools/http-egress-guard.js";

const bytes = (...values: number[]) => Buffer.from(values);
const fileOf = (head: Buffer, size = 3_000) => Buffer.concat([head, randomBytes(size)]).toString("base64");

const FILES: Record<string, Buffer> = {
  png: bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
  jpeg: bytes(0xff, 0xd8, 0xff, 0xe0),
  gif: Buffer.from("GIF89a"),
  webp: Buffer.concat([Buffer.from("RIFF"), bytes(0x24, 0x10, 0, 0), Buffer.from("WEBP")]),
  pdf: Buffer.from("%PDF-1.7\n"),
  gzip: bytes(0x1f, 0x8b, 0x08, 0x00),
  zip: bytes(0x50, 0x4b, 0x03, 0x04),
  woff2: Buffer.from("wOF2"),
  mp4: Buffer.concat([bytes(0, 0, 0, 0x20), Buffer.from("ftypisom")]),
  wasm: bytes(0x00, 0x61, 0x73, 0x6d, 0x01, 0, 0, 0),
};

describe("a file in base64 is not read as key material", () => {
  for (const [name, head] of Object.entries(FILES)) {
    it(`a ${name} is clean: bare, in a data: URL and in a JSON body`, () => {
      const encoded = fileOf(head);
      expect(scanForSecrets(encoded).clean, "bare").toBe(true);
      expect(scanForSecrets(`<img src="data:application/octet-stream;base64,${encoded}">`).clean, "data URL").toBe(true);
      expect(scanForSecrets(JSON.stringify({ name: "upload", file: encoded })).clean, "JSON").toBe(true);
    });
  }

  it("an API body carrying an image leaves through the egress guard with no card", () => {
    const body = JSON.stringify({ image: `data:image/png;base64,${fileOf(FILES.png)}` });
    expect(checkOutboundPayload("http_request", body)).toBeNull();
  });

  it("the span is the whole run, padding included, and only that run", () => {
    const encoded = fileOf(FILES.png, 300);
    expect(encoded.endsWith("=")).toBe(true);
    const text = `before ${encoded} after`;
    expect(encodedFileSpans(text)).toEqual([[7, 7 + encoded.length]]);
  });
});

describe("a key is still a guess worth asking about", () => {
  const key = () => randomBytes(48).toString("base64url");

  it("random bytes of a file's size are flagged: size does not make a file", () => {
    expect(scanForSecrets(randomBytes(3_000).toString("base64")).clean).toBe(false);
  });

  it("a data: URL prefix in front of a key exempts nothing", () => {
    for (const mime of ["image/png", "application/octet-stream", "font/woff2"]) {
      const result = scanForSecrets(`data:${mime};base64,${key()}`);
      expect(result.matches.some((m) => m.type === "high-entropy-token"), mime).toBe(true);
    }
  });

  it("a key beside a file is flagged, and the file is not", () => {
    const secret = key();
    const result = scanForSecrets(JSON.stringify({ image: fileOf(FILES.png), token: secret }));
    const guesses = result.matches.filter((m) => m.type === "high-entropy-token");
    expect(guesses.length).toBeGreaterThan(0);
    for (const guess of guesses) expect(secret).toContain(guess.value.replace(/\.\.\.$/, "").slice(0, 12));
  });

  it("a signature that is not at the start, or a run too short to be a file, exempts nothing", () => {
    const late = Buffer.concat([randomBytes(6), FILES.png, randomBytes(200)]).toString("base64");
    expect(encodedFileSpans(late)).toEqual([]);
    const short = Buffer.concat([FILES.png, randomBytes(24)]).toString("base64");
    expect(short.length).toBeLessThan(64);
    expect(encodedFileSpans(short)).toEqual([]);
  });

  it("a known key shape inside a file's bytes is still found by the catalog", () => {
    const awsKey = "AKIA" + "QWERTYUIOPASDFGH";
    const carrier = Buffer.concat([FILES.png, Buffer.from(`\naws_access_key_id=${awsKey}\n`), randomBytes(200)]).toString("base64");
    expect(scanForSecrets(`payload: ${carrier}`).clean).toBe(false);
  });
});
