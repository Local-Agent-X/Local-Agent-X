// ---------------------------------------------------------------------------
// Action preview factories — build the typed `preview` field attached to
// `approval_requested` events. Pure data, safe to call without an active
// manager. See ActionPreview in types.ts for the shape contract.
// ---------------------------------------------------------------------------

import { createPatch } from "diff";
import type { ActionPreview } from "./types.js";

const PREVIEW_BODY_LIMIT = 500;
const PREVIEW_DIFF_HEAD_LINES = 10;
const PREVIEW_DIFF_TAIL_LINES = 10;

export function previewFileEdit(
  path: string,
  oldContent: string,
  newContent: string,
): Extract<ActionPreview, { kind: "file" }> {
  const safePath = typeof path === "string" && path.length > 0 ? path : "<unknown>";
  const oldStr = typeof oldContent === "string" ? oldContent : "";
  const newStr = typeof newContent === "string" ? newContent : "";

  const patch = createPatch(safePath, oldStr, newStr, "", "", { context: 3 });
  const lines = patch.split("\n");
  const hunkStart = lines.findIndex((l) => l.startsWith("@@"));
  const header = hunkStart < 0 ? "" : lines.slice(0, hunkStart).join("\n");
  const bodyLines = hunkStart < 0 ? lines : lines.slice(hunkStart);

  let added = 0;
  let removed = 0;
  for (const line of bodyLines) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }

  let truncated = false;
  let bodyText: string;
  if (bodyLines.length > PREVIEW_DIFF_HEAD_LINES + PREVIEW_DIFF_TAIL_LINES) {
    const head = bodyLines.slice(0, PREVIEW_DIFF_HEAD_LINES);
    const tail = bodyLines.slice(-PREVIEW_DIFF_TAIL_LINES);
    const elided = bodyLines.length - PREVIEW_DIFF_HEAD_LINES - PREVIEW_DIFF_TAIL_LINES;
    bodyText = [...head, `… ${elided} line${elided === 1 ? "" : "s"} elided …`, ...tail].join("\n");
    truncated = true;
  } else {
    bodyText = bodyLines.join("\n");
  }

  return {
    kind: "file",
    path: safePath,
    diff: header ? `${header}\n${bodyText}` : bodyText,
    lineCount: { added, removed },
    truncated,
  };
}

export function previewShellCommand(
  cmd: string,
  cwd: string,
  explanation?: string,
): Extract<ActionPreview, { kind: "shell" }> {
  const out: Extract<ActionPreview, { kind: "shell" }> = {
    kind: "shell",
    cmd: typeof cmd === "string" ? cmd : "",
    cwd: typeof cwd === "string" ? cwd : "",
  };
  if (typeof explanation === "string" && explanation.length > 0) out.explanation = explanation;
  return out;
}

export function previewNetworkWrite(
  method: string,
  url: string,
  body: unknown,
): Extract<ActionPreview, { kind: "network" }> {
  const safeMethod = typeof method === "string" && method.length > 0 ? method.toUpperCase() : "GET";
  const safeUrl = typeof url === "string" ? url : "";

  let bodyStr: string;
  if (body == null) bodyStr = "";
  else if (typeof body === "string") bodyStr = body;
  else {
    try { bodyStr = JSON.stringify(body); }
    catch { bodyStr = String(body); }
  }
  const bodyTruncated = bodyStr.length > PREVIEW_BODY_LIMIT;
  const bodyPreview = bodyTruncated ? `${bodyStr.slice(0, PREVIEW_BODY_LIMIT)}…` : bodyStr;

  let domain = "";
  if (safeUrl) {
    try { domain = new URL(safeUrl).host; }
    catch {
      const m = safeUrl.match(/^(?:https?:\/\/)?([^/?#]+)/i);
      domain = m?.[1] ?? "";
    }
  }

  return { kind: "network", method: safeMethod, url: safeUrl, bodyPreview, bodyTruncated, domain };
}

export function previewMoney(
  amount: number,
  currency: string,
  recipient: string,
  source: string,
): Extract<ActionPreview, { kind: "money" }> {
  const safeAmount = typeof amount === "number" && Number.isFinite(amount) ? amount : 0;
  const safeCurrency = typeof currency === "string" && currency.length > 0 ? currency.toUpperCase() : "USD";
  const safeRecipient = typeof recipient === "string" ? recipient : "";
  const safeSource = typeof source === "string" ? source : "";

  let formatted: string;
  try {
    formatted = new Intl.NumberFormat("en-US", { style: "currency", currency: safeCurrency }).format(safeAmount);
  } catch {
    formatted = `${safeAmount.toFixed(2)} ${safeCurrency}`;
  }

  return {
    kind: "money",
    amount: safeAmount,
    currency: safeCurrency,
    recipient: safeRecipient,
    source: safeSource,
    formatted,
  };
}
