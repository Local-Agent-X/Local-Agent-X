/**
 * Per-page utility actions — extract / screenshot / evaluate / info / tabs /
 * switch_tab / dialog_accept / dialog_dismiss / close. Grouped together because
 * each handler is small and shares no domain-specific state.
 */

import type { ToolResult } from "../../types.js";
import type { BrowserBackend, ScreenshotImage } from "../../browser/index.js";
import { closeBrowser } from "../../browser/index.js";
import { evaluateBlockMessage, scanEvaluateScript, sensitivePageStub } from "../../browser/guards.js";
import { wrapExternalContent } from "../../sanitize.js";
import { ok, err, appendPostActionSnapshot } from "./shared.js";

export async function handleExtract(
  manager: BrowserBackend,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const sensitive = sensitivePageStub(manager.getCurrentUrl());
  if (sensitive) return { content: sensitive, status: "blocked", isError: true, metadata: { browserStatus: "sensitive-content-withheld" } };
  const selector = args.selector ? String(args.selector) : undefined;
  const find = args.find ? String(args.find) : undefined;
  // extractText already wraps in the untrusted-content boundary — don't re-wrap.
  return ok(await manager.extractText(selector, find));
}

export async function handleScreenshot(manager: BrowserBackend): Promise<ToolResult> {
  const sensitive = sensitivePageStub(manager.getCurrentUrl());
  if (sensitive) return { content: sensitive, status: "blocked", isError: true, metadata: { browserStatus: "sensitive-content-withheld" } };
  const shot = await manager.screenshot();
  if (!shot.image) return ok(shot.text);
  // Inline vision rides `_image` ONLY (audit-tool-call.ts turns it into a
  // vision message) — NEVER `_media`, which the bridge auto-delivers off-box.
  const result: ToolResult & { _image: ScreenshotImage } = { content: shot.text, _image: shot.image };
  return result;
}

export async function handleEvaluate(
  manager: BrowserBackend,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const sensitive = sensitivePageStub(manager.getCurrentUrl());
  if (sensitive) return { content: sensitive, status: "blocked", isError: true, metadata: { browserStatus: "sensitive-content-withheld" } };
  const script = String(args.script || "");
  if (!script) return err("'script' parameter is required for evaluate action.");
  const blockedPattern = scanEvaluateScript(script);
  if (blockedPattern) return err(evaluateBlockMessage(blockedPattern));
  return ok(await manager.evaluate(script));
}

export async function handleInfo(manager: BrowserBackend): Promise<ToolResult> {
  return ok(await manager.getInfo());
}

export async function handleTabs(manager: BrowserBackend): Promise<ToolResult> {
  return ok(await manager.listTabs());
}

export async function handleDownloads(manager: BrowserBackend): Promise<ToolResult> {
  return { content: wrapExternalContent(manager.getDownloads(), "browser.downloads"), metadata: { browserStatus: "download-status" } };
}

export async function handleReleaseDownload(
  manager: BrowserBackend,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const id = String(args.download_id || "");
  if (!id) return err("'download_id' is required. Use action='downloads' to list quarantined downloads.");
  const approved = args._downloadApproval as ReturnType<BrowserBackend["getDownloadApproval"]> | undefined;
  if (!approved) return err("Download release is missing its digest-bound approval metadata.");
  return { content: wrapExternalContent(await manager.releaseDownload(id, approved), "browser.download.release"), metadata: { browserStatus: "download-released", downloadId: id } };
}

export async function handleSwitchTab(
  manager: BrowserBackend,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const tabIndex = parseInt(String(args.value || "0"), 10);
  if (isNaN(tabIndex)) return err("'value' must be a tab index number. Use 'tabs' action to list tabs.");
  const base = await manager.switchTab(tabIndex);
  return ok(await appendPostActionSnapshot(manager, base));
}

export async function handleDialogAccept(
  manager: BrowserBackend,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const promptText = args.value !== undefined ? String(args.value) : undefined;
  const base = await manager.dialogAccept(promptText);
  return ok(await appendPostActionSnapshot(manager, base));
}

export async function handleDialogDismiss(manager: BrowserBackend): Promise<ToolResult> {
  const base = await manager.dialogDismiss();
  return ok(await appendPostActionSnapshot(manager, base));
}

export async function handleClose(sessionId: string): Promise<ToolResult> {
  await closeBrowser(sessionId);
  return ok("Browser session closed.");
}
