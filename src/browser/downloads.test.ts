import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  inspectBrowserDownload,
  releaseQuarantinedDownload,
  safeDownloadFilename,
} from "./downloads.js";
import { sensitivePageActionDecision } from "./guards.js";
import { createBrowserTools } from "../tools/browser-tools/index.js";

const roots: string[] = [];

function dirs(): { quarantineDir: string; releaseDir: string } {
  const root = mkdtempSync(join(tmpdir(), "lax-browser-download-"));
  roots.push(root);
  return { quarantineDir: join(root, "private-quarantine"), releaseDir: join(root, "released") };
}

function stream(bytes: Buffer | string): Readable {
  return Readable.from([Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)]);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("browser download quarantine", () => {
  it("sanitizes traversal, reserved names, and unsafe filename characters", () => {
    expect(safeDownloadFilename("../../CON:<report>?.pdf")).toBe("_CON__report__.pdf");
  });

  it("rejects a spoofed extension carrying executable bytes", async () => {
    const paths = dirs();
    const result = await inspectBrowserDownload({
      ...paths, sessionId: "spoof", sourceUrl: "https://files.test/report.pdf?token=secret",
      pageUrl: "https://files.test/private", suggestedFilename: "report.pdf",
      contentType: "application/pdf", stream: stream(Buffer.from("MZfake executable")),
    });
    expect(result.status).toBe("rejected");
    expect(result.reason).toMatch(/executable/i);
    expect(result.sourceUrl).not.toContain("secret");
    expect(result.quarantinePath).toBeUndefined();

    const officePaths = dirs();
    const fakeOffice = await inspectBrowserDownload({
      ...officePaths, sessionId: "fake-office", sourceUrl: "https://files.test/report.docx", pageUrl: "https://files.test/",
      suggestedFilename: "report.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      stream: stream(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4])),
    });
    expect(fakeOffice.status).toBe("rejected");
    expect(fakeOffice.reason).toMatch(/archive structure/i);
  });

  it("rejects a MIME/signature mismatch", async () => {
    const paths = dirs();
    const result = await inspectBrowserDownload({
      ...paths, sessionId: "mime", sourceUrl: "https://files.test/report.pdf", pageUrl: "https://files.test/",
      suggestedFilename: "report.pdf", contentType: "image/png", stream: stream("%PDF-1.7\nbody"),
    });
    expect(result.status).toBe("rejected");
    expect(result.reason).toMatch(/content type does not match/i);
  });

  it("removes oversized and interrupted partial files", async () => {
    const oversized = dirs();
    await expect(inspectBrowserDownload({
      ...oversized, sessionId: "large", sourceUrl: "https://files.test/a.txt", pageUrl: "https://files.test/",
      suggestedFilename: "a.txt", contentType: "text/plain", stream: stream("123456"), maxBytes: 5,
    })).rejects.toThrow(/size cap/i);
    expect(existsSync(oversized.quarantineDir) ? readdirSync(oversized.quarantineDir) : []).toEqual([]);

    const interrupted = dirs();
    async function* partial(): AsyncGenerator<Buffer> {
      yield Buffer.from("partial");
      throw new Error("connection reset");
    }
    await expect(inspectBrowserDownload({
      ...interrupted, sessionId: "partial", sourceUrl: "https://files.test/a.txt", pageUrl: "https://files.test/",
      suggestedFilename: "a.txt", contentType: "text/plain", stream: Readable.from(partial()),
    })).rejects.toThrow("connection reset");
    expect(existsSync(interrupted.quarantineDir) ? readdirSync(interrupted.quarantineDir) : []).toEqual([]);
  });

  it("rejects executables and holds archives for approval-bound release", async () => {
    const executablePaths = dirs();
    const executable = await inspectBrowserDownload({
      ...executablePaths, sessionId: "danger", sourceUrl: "https://files.test/setup.exe", pageUrl: "https://files.test/",
      suggestedFilename: "setup.exe", contentType: "application/octet-stream", stream: stream(Buffer.from("MZsetup")),
    });
    expect(executable.status).toBe("rejected");

    const archivePaths = dirs();
    const archive = await inspectBrowserDownload({
      ...archivePaths, sessionId: "archive", sourceUrl: "https://files.test/data.zip", pageUrl: "https://files.test/",
      suggestedFilename: "data.zip", contentType: "application/zip",
      stream: stream(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4])),
    });
    expect(archive.status).toBe("quarantined");
    expect(existsSync(join(archivePaths.releaseDir, "data.zip"))).toBe(false);
    const released = await releaseQuarantinedDownload("archive", archive.id, archivePaths.releaseDir);
    expect(released.status).toBe("released");
    expect(readFileSync(released.releasePath!)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]));
  });

  it("releases a normal safe file only after checks pass", async () => {
    const paths = dirs();
    const result = await inspectBrowserDownload({
      ...paths, sessionId: "safe", sourceUrl: "https://files.test/report.pdf", pageUrl: "https://files.test/",
      suggestedFilename: "report.pdf", contentType: "application/pdf", stream: stream("%PDF-1.7\nsafe"),
    });
    expect(result.status).toBe("released");
    expect(readFileSync(result.releasePath!, "utf8")).toBe("%PDF-1.7\nsafe");
    expect(result.metadataPath).toContain(paths.quarantineDir);
  });
});

describe("browser sensitive-page gates", () => {
  it("requires approval for high-risk financial and admin actions", () => {
    expect(sensitivePageActionDecision("https://paypal.com/myaccount/payments", "click").disposition).toBe("approval-required");
    expect(sensitivePageActionDecision("https://console.aws.amazon.com/console/home", "fill").disposition).toBe("approval-required");
  });

  it("blocks secret-reading actions without exposing a recovery URL token", () => {
    const decision = sensitivePageActionDecision("https://vault.bitwarden.com/passwords?token=secret", "extract");
    expect(decision.disposition).toBe("blocked");
    expect(JSON.stringify(decision)).not.toContain("token=secret");
  });

  it("does not release downloads when no interactive approval channel exists", async () => {
    const browser = createBrowserTools()[0];
    const result = await browser.execute({ action: "release_download", download_id: "dl-test", _sessionId: "approval-test" });
    expect(result.status).toBe("blocked");
    expect(result.content).toMatch(/explicit user approval/i);
  });
});
