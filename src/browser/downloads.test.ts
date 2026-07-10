import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import JSZip from "jszip";
import {
  getDownloadApprovalBinding,
  inspectBrowserDownload,
  releaseQuarantinedDownload,
  safeDownloadFilename,
} from "./downloads.js";
import { sensitivePageActionDecision } from "./guards.js";
import { createBrowserTools } from "../tools/browser-tools/index.js";
import { getApprovalManager } from "../approval-manager.js";
import type { ServerEvent } from "../types.js";
import { handleNavigate, handleSnapshot } from "../tools/browser-tools/navigation.js";
import { handleObserve } from "../tools/browser-tools/observe.js";
import type { BrowserManager } from "./manager.js";

const roots: string[] = [];

function dirs(): { quarantineDir: string; releaseDir: string } {
  const root = mkdtempSync(join(tmpdir(), "lax-browser-download-"));
  roots.push(root);
  return { quarantineDir: join(root, "private-quarantine"), releaseDir: join(root, "released") };
}

function stream(bytes: Buffer | string): Readable {
  return Readable.from([Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)]);
}

async function zip(entries: Record<string, string | Buffer>, compression: "STORE" | "DEFLATE" = "STORE"): Promise<Buffer> {
  const archive = new JSZip();
  for (const [name, value] of Object.entries(entries)) archive.file(name, value);
  return archive.generateAsync({ type: "nodebuffer", compression });
}

function encryptZipHeaders(bytes: Buffer): Buffer {
  const out = Buffer.from(bytes);
  for (const [signature, flagOffset] of [[0x04034b50, 6], [0x02014b50, 8]] as const) {
    let offset = 0;
    while ((offset = out.indexOf(Buffer.from([signature & 0xff, (signature >> 8) & 0xff, (signature >> 16) & 0xff, (signature >> 24) & 0xff]), offset)) >= 0) {
      out.writeUInt16LE(out.readUInt16LE(offset + flagOffset) | 1, offset + flagOffset);
      offset += 4;
    }
  }
  return out;
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
      stream: stream(await zip({ "random.txt": "not an OOXML package" })),
    });
    expect(fakeOffice.status).toBe("rejected");
    expect(fakeOffice.reason).toMatch(/OOXML/i);
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
    const archiveBytes = await zip({ "data.txt": "archive data" });
    const archive = await inspectBrowserDownload({
      ...archivePaths, sessionId: "archive", sourceUrl: "https://files.test/data.zip", pageUrl: "https://files.test/",
      suggestedFilename: "data.zip", contentType: "application/zip",
      stream: stream(archiveBytes),
    });
    expect(archive.status).toBe("quarantined");
    expect(existsSync(join(archivePaths.releaseDir, "data.zip"))).toBe(false);
    const binding = getDownloadApprovalBinding("archive", archive.id);
    const released = await releaseQuarantinedDownload("archive", archive.id, binding, archivePaths.releaseDir);
    expect(released.status).toBe("released");
    expect(readFileSync(released.releasePath!)).toEqual(archiveBytes);
  });

  it("parses OOXML central-directory structure and rejects malformed, encrypted, traversal, and bomb archives", async () => {
    const contentTypes = `<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
    const validPaths = dirs();
    const valid = await inspectBrowserDownload({
      ...validPaths, sessionId: "docx", sourceUrl: "https://files.test/a.docx", pageUrl: "https://files.test/",
      suggestedFilename: "a.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      stream: stream(await zip({ "[Content_Types].xml": contentTypes, "word/document.xml": "<document/>" })),
    });
    expect(valid.status).toBe("released");

    const cases: Array<[string, Buffer, RegExp]> = [
      ["malformed", Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2]), /malformed/i],
      ["encrypted", encryptZipHeaders(await zip({ "a.txt": "secret" })), /encrypted/i],
      ["traversal", await zip({ "../escape.txt": "bad" }), /traversal/i],
      ["bomb", await zip({ "huge.txt": Buffer.alloc(11 * 1024 * 1024) }, "DEFLATE"), /zip bomb|expansion ratio/i],
    ];
    for (const [name, bytes, reason] of cases) {
      const paths = dirs();
      const result = await inspectBrowserDownload({
        ...paths, sessionId: name, sourceUrl: `https://files.test/${name}.zip`, pageUrl: "https://files.test/",
        suggestedFilename: `${name}.zip`, contentType: "application/zip", stream: stream(bytes),
      });
      expect(result.status, name).toBe("rejected");
      expect(result.reason, name).toMatch(reason);
    }
  });

  it("never auto-releases arbitrary ZIPs named as OpenDocument files", async () => {
    const types: Array<[string, string]> = [
      ["odt", "application/vnd.oasis.opendocument.text"],
      ["ods", "application/vnd.oasis.opendocument.spreadsheet"],
      ["odp", "application/vnd.oasis.opendocument.presentation"],
    ];
    for (const [extension, contentType] of types) {
      const paths = dirs();
      const result = await inspectBrowserDownload({
        ...paths, sessionId: `odf-${extension}`, sourceUrl: `https://files.test/arbitrary.${extension}`,
        pageUrl: "https://files.test/", suggestedFilename: `arbitrary.${extension}`, contentType,
        stream: stream(await zip({ "arbitrary.txt": "not an OpenDocument package" })),
      });
      expect(result.status, extension).toBe("quarantined");
      expect(result.reason, extension).toMatch(/OpenDocument.*approval/i);
      expect(result.quarantinePath, extension).toBeTruthy();
      expect(existsSync(join(paths.releaseDir, `arbitrary.${extension}`)), extension).toBe(false);
    }
  });

  it("binds release to exact metadata and rejects changed or symlinked quarantine bytes", async () => {
    const changedPaths = dirs();
    const changed = await inspectBrowserDownload({
      ...changedPaths, sessionId: "changed", sourceUrl: "https://files.test/a.zip", pageUrl: "https://files.test/",
      suggestedFilename: "a.zip", contentType: "application/zip", stream: stream(await zip({ "a.txt": "original" })),
    });
    const changedBinding = getDownloadApprovalBinding("changed", changed.id);
    await expect(releaseQuarantinedDownload("changed", changed.id, { ...changedBinding, size: changedBinding.size + 1 }, changedPaths.releaseDir)).rejects.toThrow(/metadata/i);

    const tamperedPaths = dirs();
    const tampered = await inspectBrowserDownload({
      ...tamperedPaths, sessionId: "tampered", sourceUrl: "https://files.test/a.zip", pageUrl: "https://files.test/",
      suggestedFilename: "a.zip", contentType: "application/zip", stream: stream(await zip({ "a.txt": "original" })),
    });
    const tamperedBinding = getDownloadApprovalBinding("tampered", tampered.id);
    writeFileSync(tampered.quarantinePath!, Buffer.alloc(tampered.size, 0x41));
    await expect(releaseQuarantinedDownload("tampered", tampered.id, tamperedBinding, tamperedPaths.releaseDir)).rejects.toThrow(/digest|changed/i);
    expect(existsSync(join(tamperedPaths.releaseDir, "a.zip"))).toBe(false);

    const symlinkPaths = dirs();
    const symlinked = await inspectBrowserDownload({
      ...symlinkPaths, sessionId: "symlink", sourceUrl: "https://files.test/a.zip", pageUrl: "https://files.test/",
      suggestedFilename: "a.zip", contentType: "application/zip", stream: stream(await zip({ "a.txt": "original" })),
    });
    const symlinkBinding = getDownloadApprovalBinding("symlink", symlinked.id);
    const moved = `${symlinked.quarantinePath}.moved`;
    renameSync(symlinked.quarantinePath!, moved);
    try {
      symlinkSync(moved, symlinked.quarantinePath!);
      await expect(releaseQuarantinedDownload("symlink", symlinked.id, symlinkBinding, symlinkPaths.releaseDir)).rejects.toThrow(/regular file|symbolic/i);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
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
    expect(sensitivePageActionDecision("https://vault.bitwarden.com/passwords", "snapshot").disposition).toBe("blocked");
    expect(sensitivePageActionDecision("https://example.com/account-recovery/token-value", "observe").disposition).toBe("blocked");
  });

  it("withholds navigation auto-snapshots, snapshots, and observations on secret-bearing pages", async () => {
    let url = "https://example.com/";
    const snapshot = vi.fn(async () => "SECRET DOM VALUE");
    const manager = {
      getCurrentUrl: () => url,
      navigate: async () => { url = "https://example.com/account-recovery/token-value?secret=yes"; return "SECRET NAV TITLE"; },
      snapshot,
      observe: vi.fn(async () => { throw new Error("observe must not run"); }),
    } as unknown as BrowserManager;
    const nav = await handleNavigate(manager, { url: "https://example.com/account-recovery/token-value?secret=yes" }, undefined);
    expect(nav.content).toContain("SENSITIVE PAGE CONTENT WITHHELD");
    expect(nav.content).not.toMatch(/SECRET|token-value|secret=yes/);
    expect(snapshot).not.toHaveBeenCalled();
    expect((await handleSnapshot(manager)).status).toBe("blocked");
    expect((await handleObserve(manager)).status).toBe("blocked");
  });

  it("does not release downloads when no interactive approval channel exists", async () => {
    const browser = createBrowserTools()[0];
    const result = await browser.execute({ action: "release_download", download_id: "dl-test", _sessionId: "approval-test" });
    expect(result.status).toBe("blocked");
    expect(result.content).toMatch(/explicit user approval/i);
  });

  it("binds the interactive approval card to inspected digest, size, and type metadata", async () => {
    const paths = dirs();
    const archive = await inspectBrowserDownload({
      ...paths, sessionId: "approval-binding", sourceUrl: "https://files.test/bound.zip", pageUrl: "https://files.test/",
      suggestedFilename: "bound.zip", contentType: "application/zip", stream: stream(await zip({ "a.txt": "bound" })),
    });
    const events: ServerEvent[] = [];
    const browser = createBrowserTools()[0];
    const pending = browser.execute({
      action: "release_download", download_id: archive.id, _sessionId: "approval-binding",
      _toolCallId: "release-bound", _onEvent: (event: ServerEvent) => events.push(event),
    });
    await vi.waitFor(() => expect(events.some((event) => event.type === "approval_requested")).toBe(true));
    const request = events.find((event) => event.type === "approval_requested");
    if (!request || request.type !== "approval_requested") throw new Error("approval event missing");
    const preview = JSON.parse(request.argsPreview) as Record<string, unknown>;
    expect(preview).toMatchObject({
      download_id: archive.id,
      digest: archive.digest,
      size: archive.size,
      filename: archive.filename,
      content_type: "application/zip",
      detected_type: "zip",
    });
    getApprovalManager().resolveApproval(request.approvalId, false);
    expect((await pending).status).toBe("declined");
  });
});
