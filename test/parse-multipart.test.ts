import { describe, it, expect } from "vitest";
import { parseMultipart, type MultipartPart } from "../src/server-utils.js";

const CRLF = "\r\n";

/**
 * Build a well-formed multipart/form-data body for a set of parts.
 * Each part: { headers, data } where data is a Buffer.
 */
function buildBody(boundary: string, parts: Array<{ headers: string[]; data: Buffer }>, opts: { finalBoundary?: boolean; leadingCrlf?: boolean } = {}): Buffer {
  const { finalBoundary = true, leadingCrlf = false } = opts;
  const chunks: Buffer[] = [];
  if (leadingCrlf) chunks.push(Buffer.from(CRLF));
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}${CRLF}`));
    chunks.push(Buffer.from(p.headers.join(CRLF) + CRLF + CRLF));
    chunks.push(p.data);
    chunks.push(Buffer.from(CRLF));
  }
  if (finalBoundary) chunks.push(Buffer.from(`--${boundary}--${CRLF}`));
  return Buffer.concat(chunks);
}

describe("parseMultipart", () => {
  it("extracts field, filename, content-type and bytes for a single part", () => {
    const boundary = "----testboundary";
    const body = buildBody(boundary, [
      {
        headers: [
          'Content-Disposition: form-data; name="file"; filename="hello.txt"',
          "Content-Type: text/plain",
        ],
        data: Buffer.from("hello world"),
      },
    ]);

    const parts = parseMultipart(body, boundary);
    expect(parts).toHaveLength(1);
    expect(parts[0].name).toBe("file");
    expect(parts[0].filename).toBe("hello.txt");
    expect(parts[0].contentType).toBe("text/plain");
    expect(parts[0].data.toString()).toBe("hello world");
  });

  it("extracts each part correctly from a multi-part body", () => {
    const boundary = "X-BOUNDARY-123";
    const body = buildBody(boundary, [
      {
        headers: ['Content-Disposition: form-data; name="field1"'],
        data: Buffer.from("value-one"),
      },
      {
        headers: [
          'Content-Disposition: form-data; name="upload"; filename="data.bin"',
          "Content-Type: application/octet-stream",
        ],
        data: Buffer.from("second-part-bytes"),
      },
    ]);

    const parts = parseMultipart(body, boundary);
    expect(parts).toHaveLength(2);

    expect(parts[0].name).toBe("field1");
    expect(parts[0].filename).toBeUndefined();
    expect(parts[0].contentType).toBeUndefined();
    expect(parts[0].data.toString()).toBe("value-one");

    expect(parts[1].name).toBe("upload");
    expect(parts[1].filename).toBe("data.bin");
    expect(parts[1].contentType).toBe("application/octet-stream");
    expect(parts[1].data.toString()).toBe("second-part-bytes");
  });

  it("handles a leading CRLF before the first boundary", () => {
    const boundary = "lead-crlf-bnd";
    const body = buildBody(
      boundary,
      [
        {
          headers: ['Content-Disposition: form-data; name="a"'],
          data: Buffer.from("payload"),
        },
      ],
      { leadingCrlf: true },
    );

    const parts = parseMultipart(body, boundary);
    expect(parts).toHaveLength(1);
    expect(parts[0].name).toBe("a");
    expect(parts[0].data.toString()).toBe("payload");
  });

  it("does not include the trailing CRLF that precedes the next boundary in the data", () => {
    const boundary = "trail-crlf-bnd";
    const payload = "no-trailing-newline-here";
    const body = buildBody(boundary, [
      {
        headers: ['Content-Disposition: form-data; name="b"'],
        data: Buffer.from(payload),
      },
    ]);

    const parts = parseMultipart(body, boundary);
    expect(parts).toHaveLength(1);
    // The CRLF separating the data from the closing boundary must be stripped.
    expect(parts[0].data.toString()).toBe(payload);
    expect(parts[0].data.length).toBe(Buffer.byteLength(payload));
  });

  it("preserves binary bytes exactly (including NULs and high bytes)", () => {
    const boundary = "binary-bnd";
    // Full byte spectrum 0x00..0xFF.
    const raw = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const body = buildBody(boundary, [
      {
        headers: [
          'Content-Disposition: form-data; name="blob"; filename="bytes.dat"',
          "Content-Type: application/octet-stream",
        ],
        data: raw,
      },
    ]);

    const parts = parseMultipart(body, boundary);
    expect(parts).toHaveLength(1);
    expect(parts[0].data.length).toBe(256);
    expect(Buffer.compare(parts[0].data, raw)).toBe(0);
  });

  it("handles a missing final closing boundary without corrupting the parts it can recover", () => {
    // No closing "--boundary--" terminator. The parser scans boundary-to-boundary,
    // so it can only emit parts that are bracketed by two boundary markers.
    const boundary = "no-final-bnd";
    const body = buildBody(
      boundary,
      [
        {
          headers: ['Content-Disposition: form-data; name="first"'],
          data: Buffer.from("first-value"),
        },
        {
          headers: ['Content-Disposition: form-data; name="second"'],
          data: Buffer.from("second-value"),
        },
      ],
      { finalBoundary: false },
    );

    const parts = parseMultipart(body, boundary);

    // PINNED CURRENT BEHAVIOR: the parser needs a *following* boundary marker to
    // close a part. Without a final closing boundary, the last part (which has no
    // trailing boundary after it) is dropped. Any recovered parts must be intact.
    expect(parts).toHaveLength(1);
    expect(parts[0].name).toBe("first");
    expect(parts[0].data.toString()).toBe("first-value");
  });

  it("returns an empty array when the boundary is absent from the body", () => {
    const parts = parseMultipart(Buffer.from("not multipart at all"), "missing");
    expect(parts).toEqual([]);
  });
});
