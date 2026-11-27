import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_RANGE_BYTES, byteRangeOf, sendFileOrRange } from "./byte-range.js";

const MB = 1024 * 1024;

// A video over the phone's 8 MB tunnel answer was refused as too large
// (2026-11-26): a player asks for it in pieces, and each answer is one.
describe("byteRangeOf", () => {
  it("caps an open-ended range to one piece", () => {
    expect(byteRangeOf("bytes=0-", 50 * MB)).toEqual({ start: 0, end: MAX_RANGE_BYTES - 1 });
    expect(byteRangeOf("bytes=10485760-", 50 * MB)).toEqual({ start: 10 * MB, end: 10 * MB + MAX_RANGE_BYTES - 1 });
  });

  it("keeps a closed range inside the file and inside one piece", () => {
    expect(byteRangeOf("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(byteRangeOf("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
    expect(byteRangeOf(`bytes=0-${20 * MB}`, 50 * MB)).toEqual({ start: 0, end: MAX_RANGE_BYTES - 1 });
  });

  it("takes the last N bytes", () => {
    expect(byteRangeOf("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
  });

  it("asks for none without a single byte range, so the whole file goes", () => {
    for (const header of [undefined, "", "bytes=-", "items=0-5", "bytes=0-5,10-20"]) expect(byteRangeOf(header, 1000)).toBeNull();
  });

  it("is unsatisfiable past the end", () => {
    expect(byteRangeOf("bytes=1000-", 1000)).toBe("unsatisfiable");
    expect(byteRangeOf("bytes=5-2", 1000)).toBe("unsatisfiable");
  });
});

describe("sendFileOrRange", () => {
  const dir = mkdtempSync(join(tmpdir(), "lax-byte-range-"));
  const file = join(dir, "clip.mp4");
  writeFileSync(file, Buffer.from("0123456789"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function send(range?: string): { status: number; headers: Record<string, string>; body: string } {
    const out = { status: 0, headers: {} as Record<string, string>, body: "" };
    const res = {
      writeHead: (status: number, headers: Record<string, string>) => { out.status = status; out.headers = headers; },
      end: (body?: Buffer) => { out.body = body ? body.toString() : ""; },
    } as unknown as ServerResponse;
    sendFileOrRange({ headers: range === undefined ? {} : { range } } as IncomingMessage, res, file, { "Content-Type": "video/mp4" });
    return out;
  }

  it("sends the piece asked for, with where it sits in the file", () => {
    expect(send("bytes=2-5")).toEqual({ status: 206, headers: { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Range": "bytes 2-5/10" }, body: "2345" });
  });

  it("sends the whole file, as before, when no range is asked", () => {
    expect(send()).toEqual({ status: 200, headers: { "Content-Type": "video/mp4", "Accept-Ranges": "bytes" }, body: "0123456789" });
  });

  it("says a range past the end cannot be met", () => {
    expect(send("bytes=20-")).toMatchObject({ status: 416, headers: { "Content-Range": "bytes */10" } });
  });
});
