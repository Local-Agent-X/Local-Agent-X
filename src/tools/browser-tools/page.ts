/**
 * Per-page utility actions — extract / screenshot / evaluate / info / tabs /
 * switch_tab / dialog_accept / dialog_dismiss / close. Grouped together because
 * each handler is small and shares no domain-specific state.
 */

import type { ToolResult } from "../../types.js";
import type { BrowserManager } from "../../browser/index.js";
import { closeBrowser } from "../../browser/index.js";
import { scanEvaluateScript, sensitivePageStub } from "../../browser/guards.js";
import { wrapExternalContent } from "../../sanitize.js";
import { ok, err, appendPostActionSnapshot } from "./shared.js";

export async function handleExtract(
  manager: BrowserManager,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const sensitive = sensitivePageStub(manager.getCurrentUrl());
  if (sensitive) return { content: sensitive, status: "blocked", isError: true, metadata: { browserStatus: "sensitive-content-withheld" } };
  const selector = args.selector ? String(args.selector) : undefined;
  const find = args.find ? String(args.find) : undefined;
  // extractText already wraps in the untrusted-content boundary — don't re-wrap.
  return ok(await manager.extractText(selector, find));
}

export async function handleScreenshot(manager: BrowserManager): Promise<ToolResult> {
  const sensitive = sensitivePageStub(manager.getCurrentUrl());
  if (sensitive) return { content: sensitive, status: "blocked", isError: true, metadata: { browserStatus: "sensitive-content-withheld" } };
  return ok(await manager.screenshot());
}

export async function handleEvaluate(
  manager: BrowserManager,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const sensitive = sensitivePageStub(manager.getCurrentUrl());
  if (sensitive) return { content: sensitive, status: "blocked", isError: true, metadata: { browserStatus: "sensitive-content-withheld" } };
  const script = String(args.script || "");
  if (!script) return err("'script' parameter is required for evaluate action.");
  const blockedPattern = scanEvaluateScript(script);
  if (blockedPattern) {
    return err(
      `Blocked: script contains restricted pattern (${blockedPattern}). ` +
      `evaluate() is for DOM inspection only — use http_request for API calls.`
    );
  }
  return ok(await manager.evaluate(script));
}

export async function handleInfo(manager: BrowserManager): Promise<ToolResult> {
  return ok(await manager.getInfo());
}

export async function handleTabs(manager: BrowserManager): Promise<ToolResult> {
  return ok(await manager.listTabs());
}

export async function handleDownloads(manager: BrowserManager): Promise<ToolResult> {
  return { content: wrapExternalContent(manager.getDownloads(), "browser.downloads"), metadata: { browserStatus: "download-status" } };
}

export async function handleReleaseDownload(
  manager: BrowserManager,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const id = String(args.download_id || "");
  if (!id) return err("'download_id' is required. Use action='downloads' to list quarantined downloads.");
  const approved = args._downloadApproval as ReturnType<BrowserManager["getDownloadApproval"]> | undefined;
  if (!approved) return err("Download release is missing its digest-bound approval metadata.");
  return { content: wrapExternalContent(await manager.releaseDownload(id, approved), "browser.download.release"), metadata: { browserStatus: "download-released", downloadId: id } };
}

export async function handleSwitchTab(
  manager: BrowserManager,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const tabIndex = parseInt(String(args.value || "0"), 10);
  if (isNaN(tabIndex)) return err("'value' must be a tab index number. Use 'tabs' action to list tabs.");
  const base = await manager.switchTab(tabIndex);
  return ok(await appendPostActionSnapshot(manager, base));
}

export async function handleDialogAccept(
  manager: BrowserManager,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const promptText = args.value !== undefined ? String(args.value) : undefined;
  const base = await manager.dialogAccept(promptText);
  return ok(await appendPostActionSnapshot(manager, base));
}

export async function handleDialogDismiss(manager: BrowserManager): Promise<ToolResult> {
  const base = await manager.dialogDismiss();
  return ok(await appendPostActionSnapshot(manager, base));
}

export async function handleClose(sessionId: string): Promise<ToolResult> {
  await closeBrowser(sessionId);
  return ok("Browser session closed.");
}
