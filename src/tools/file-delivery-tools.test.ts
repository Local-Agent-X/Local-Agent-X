// send_file tests — staging a validated document into the served uploads dir
// (the only file prefix the phone tunnel allowlists) + the result contract the
// phone's file-card extraction depends on.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendFileTool, stagedName, DOC_MIME } from "./file-delivery-tools.js";

let tmpRoot: string;
let srcDir: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "lax-sendfile-test-"));
  srcDir = mkdtempSync(join(tmpdir(), "lax-sendfile-src-"));
  prevDataDir = process.env.LAX_DATA_DIR;
  process.env.LAX_DATA_DIR = tmpRoot;
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prevDataDir;
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(srcDir, { recursive: true, force: true });
});

describe("stagedName", () => {
  it("keeps the extension and prefixes a short content hash", () => {
    expect(stagedName("Q3 Report.xlsx", "abcdef0123456789")).toBe("abcdef01-Q3_Report.xlsx");
  });

  it("sanitizes to the /uploads filename charset and never yields a dot-leading name", () => {
    // Leading traversal/dot/underscore runs are stripped; every other unsafe
    // char becomes "_" so the name passes /uploads' strict serving regex.
    expect(stagedName("../..\\évil name?.docx", "ffff0000aaaa")).toBe("ffff0000-vil_name_.docx");
    expect(stagedName("...hidden", "1234abcd9999")).toBe("1234abcd-hidden");
    expect(/[^a-zA-Z0-9._-]/.test(stagedName("a b/c*d.pdf", "0000000011"))).toBe(false);
  });
});

describe("send_file", () => {
  it("stages a copy under /uploads and returns the ref FIRST in the result text", async () => {
    const src = join(srcDir, "budget.xlsx");
    writeFileSync(src, Buffer.from("fake-xlsx-bytes"));

    const res = await sendFileTool.execute!({ path: src }, undefined as never);
    expect(res.isError).toBeFalsy();
    const match = /\/uploads\/([A-Za-z0-9._-]+\.xlsx)/.exec(String(res.content));
    expect(match).not.toBeNull();
    // The ref must appear within the first 500 chars — history projection
    // truncates tool results there and the phone re-parses from history.
    expect(String(res.content).indexOf("/uploads/")).toBeLessThan(200);

    const staged = join(tmpRoot, "uploads", match![1]!);
    expect(existsSync(staged)).toBe(true);
    expect(readFileSync(staged).equals(readFileSync(src))).toBe(true);

    const media = (res as { _media?: { kind: string; path: string; mime: string; name?: string } })._media;
    expect(media).toMatchObject({ kind: "file", path: staged, mime: DOC_MIME.xlsx, name: "budget.xlsx" });
  });

  it("honors the display-name override", async () => {
    const src = join(srcDir, "tmp-83f.docx");
    writeFileSync(src, "doc");
    const res = await sendFileTool.execute!({ path: src, name: "Offer letter" }, undefined as never);
    const media = (res as { _media?: { name?: string } })._media;
    expect(media?.name).toBe("Offer letter");
    expect(String(res.content)).toContain('"Offer letter"');
  });

  it("rejects unsupported types with a pointer to the right tool", async () => {
    const src = join(srcDir, "movie.mp4");
    writeFileSync(src, "vid");
    const res = await sendFileTool.execute!({ path: src }, undefined as never);
    expect(res.isError).toBe(true);
    expect(String(res.content)).toContain("send_video");
  });

  it("errors cleanly on a missing file", async () => {
    const res = await sendFileTool.execute!({ path: join(srcDir, "nope.pdf") }, undefined as never);
    expect(res.isError).toBe(true);
    expect(String(res.content)).toContain("File not found");
  });

  it("dedupes identical content to the same staged name", async () => {
    const a = join(srcDir, "same.pdf");
    writeFileSync(a, "identical-bytes");
    const first = await sendFileTool.execute!({ path: a }, undefined as never);
    const second = await sendFileTool.execute!({ path: a }, undefined as never);
    const ref = (s: unknown): string => /\/uploads\/\S+/.exec(String((s as { content: string }).content))![0]!;
    expect(ref(first)).toBe(ref(second));
  });
});
