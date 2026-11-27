import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

// The read gate is the user's File Access setting; each test sets what it says.
const gate = vi.hoisted(() => ({ allowed: true }));
vi.mock("../security/layer/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../security/layer/index.js")>()),
  evaluateFileAccess: () => (gate.allowed ? { allowed: true } : { allowed: false, reason: "Blocked: workspace mode" }),
}));

import { localFileRefusal, localFilesAddress, serveLocalFile } from "./local-files.js";

const base = mkdtempSync(join(tmpdir(), "lax-local-files-"));
const pictures = join(base, "Pictures");
mkdirSync(pictures, { recursive: true });
for (const name of ["photo.png", "page.html", "drawing.svg", "deck.pptx", ".env"]) writeFileSync(join(pictures, name), "x");
afterAll(() => rmSync(base, { recursive: true, force: true }));
beforeEach(() => { gate.allowed = true; });

function serve(absPath: string): { status: number; headers: Record<string, string> } {
  const out = { status: 0, headers: {} as Record<string, string> };
  const res = {
    writeHead: (status: number, headers: Record<string, string> = {}) => { out.status = status; out.headers = headers; return res; },
    setHeader: () => undefined,
    end: () => undefined,
  } as unknown as ServerResponse;
  serveLocalFile(new URL("http://127.0.0.1" + localFilesAddress(absPath)), { headers: {} } as IncomingMessage, res);
  return out;
}

// A device opens a file outside the workspace a reply named (owner's call,
// 2026-11-26): what the agent's read gate allows, and only what cannot run on
// the UI's own origin.
describe("local files a device may open", () => {
  it("serves a picture the read gate allows, in place", () => {
    expect(localFileRefusal(join(pictures, "photo.png"))).toBeNull();
    expect(serve(join(pictures, "photo.png"))).toMatchObject({ status: 200, headers: { "Content-Type": "image/png", "X-Content-Type-Options": "nosniff" } });
  });

  it("downloads an Office file rather than showing it", () => {
    expect(serve(join(pictures, "deck.pptx")).headers["Content-Disposition"]).toContain("deck.pptx");
  });

  it("follows the user's File Access setting", () => {
    gate.allowed = false;
    expect(localFileRefusal(join(pictures, "photo.png"))).toBe("Blocked: workspace mode");
    expect(serve(join(pictures, "photo.png")).status).toBe(403);
  });

  it("never serves what runs on this origin, a credential file, a missing file or a relative path", () => {
    expect(localFileRefusal(join(pictures, "page.html"))).toBe("not a document, picture or media file");
    expect(localFileRefusal(join(pictures, "drawing.svg"))).toBe("not a document, picture or media file");
    expect(localFileRefusal(join(pictures, ".env"))).not.toBeNull();
    expect(localFileRefusal(join(pictures, "gone.png"))).toBe("no such file");
    expect(serve(join(pictures, "gone.png")).status).toBe(404);
    expect(localFileRefusal("Pictures/photo.png")).toBe("not a full path");
  });
});
