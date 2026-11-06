// The browser's `images` action (browser/page-images.ts): the open page's pictures with
// their alt text and links, for the agent to put on a card (show_card). Run like
// layout_report: withheld on a sensitive page, the fixed script scanned by the evaluate
// blocklist on the path both backends share, its output wrapped as page content.
import type { ToolResult } from "../../types.js";
import type { BrowserBackend } from "../../browser/backend.js";
import { PAGE_IMAGES_SCRIPT } from "../../browser/page-images.js";
import { scanEvaluateScript, sensitivePageStub } from "../../browser/guards.js";
import { wrapExternalContent } from "../../sanitize.js";
import { err, withheld } from "./shared.js";

export async function handlePageImages(manager: BrowserBackend): Promise<ToolResult> {
  const sensitive = sensitivePageStub(manager.getCurrentUrl());
  if (sensitive) return withheld(sensitive);
  const blocked = scanEvaluateScript(PAGE_IMAGES_SCRIPT);
  if (blocked) {
    return err(`images did not run: its own script was rejected by the evaluate blocklist (pattern ${blocked}). That is a bug in the script, not in the page.`);
  }
  const raw = await manager.evaluate(PAGE_IMAGES_SCRIPT);
  return {
    content: wrapExternalContent(raw, "browser.images"),
    metadata: { browserStatus: "images" },
  };
}
