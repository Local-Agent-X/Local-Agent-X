/**
 * Pure text formatters for browser observations — extracted from
 * observation.ts to keep it under the file-size ceiling. The ONLY consumer is
 * ObservationRegistry.format/formatRef (observation.ts); the public snapshot
 * API is unchanged. All page-derived strings pass through sanitizeText so a
 * hostile page can't forge section markers or break the ref line grammar.
 */
import type { DurableRef, ObservationDegradation } from "./observation.js";
import type { Obstruction } from "./modal-detector.js";
import type { IframeInfo } from "./iframe-detector.js";
import type { CapturedDialog } from "./dialog-handler.js";

export function formatRef(r: DurableRef): string {
  const safeName = sanitizeText(r.name).slice(0, 80);
  const safeRole = (r.role || r.tag.toLowerCase()).replace(/[\r\n<>]/g, "").slice(0, 20);
  const typeAttr = r.type ? ` type=${r.type.replace(/[\r\n<>]/g, "").slice(0, 16)}` : "";
  const offBadge = r.inViewport ? "" : " [offscreen]";
  return `[${r.id}]<${safeRole}${typeAttr}>${safeName}</${safeRole}>${offBadge}`;
}

export function formatDegraded(degraded: ObservationDegradation[]): string {
  const labels: Record<ObservationDegradation["op"], string> = {
    elements: "Element extraction",
    obstructions: "Obstruction detection",
    iframes: "Iframe listing",
  };
  const lines = ["== OBSERVATION DEGRADED (a page sub-scan FAILED — this is NOT a clean page state) =="];
  for (const d of degraded) {
    lines.push(`  ${labels[d.op]} FAILED: ${sanitizeText(d.reason).slice(0, 200) || "(no reason given)"}`);
  }
  if (degraded.some((d) => d.op === "elements")) {
    lines.push(
      "  The interactive-element list is incomplete or absent — an empty list here does NOT mean the page has no interactive elements.",
      `  Use browser({action:"screenshot"}) to see the page before acting; do not guess selectors or coordinates from this snapshot.`
    );
  }
  return lines.join("\n");
}

export function formatDialogs(dialogs: CapturedDialog[]): string {
  const lines: string[] = ["== NATIVE DIALOG (browser-level, blocks the page) =="];
  for (const d of dialogs) {
    lines.push(`  ${d.type}: "${sanitizeText(d.message).slice(0, 200)}"`);
  }
  lines.push(
    `  Call browser({action:"dialog_accept"}) or browser({action:"dialog_dismiss"}) to handle. ` +
      `For prompt() pass {action:"dialog_accept", value:"<text>"}.`
  );
  return lines.join("\n");
}

export function formatObstructions(obstructions: Obstruction[], refs: DurableRef[]): string {
  const xpathToRef = new Map<string, DurableRef>();
  for (const r of refs) xpathToRef.set(r.xpath, r);

  const lines: string[] = ["== OBSTRUCTION DETECTED (handle before interacting with the rest of the page) =="];
  for (const o of obstructions.slice(0, 4)) {
    const name = sanitizeText(o.name).slice(0, 80) || "(no label)";
    lines.push(`  [${o.kind}] z=${o.zIndex} "${name}"`);
    if (o.acceptXPath) {
      const ref = xpathToRef.get(o.acceptXPath);
      const label = sanitizeText(o.acceptText || "accept");
      lines.push(`    Accept: ${ref ? `[${ref.id}] ` : ""}"${label}"${ref ? "" : " — not in ref list, use click_text"}`);
    }
    if (o.dismissXPath) {
      const ref = xpathToRef.get(o.dismissXPath);
      const label = sanitizeText(o.dismissText || "dismiss");
      lines.push(`    Dismiss: ${ref ? `[${ref.id}] ` : ""}"${label}"${ref ? "" : " — not in ref list, use click_text"}`);
    }
    if (!o.acceptXPath && !o.dismissXPath) {
      lines.push(`    No accept/dismiss button found — use evaluate or click_text`);
    }
  }
  if (obstructions.length > 4) {
    lines.push(`  ...and ${obstructions.length - 4} more`);
  }
  return lines.join("\n");
}

export function formatIframes(frames: IframeInfo[]): string {
  const lines: string[] = ["== IFRAMES (cross-origin — refs do NOT reach inside; use evaluate or interact with the container) =="];
  for (const f of frames.slice(0, 6)) {
    lines.push(`  ${f.origin} (${f.rect.width}×${f.rect.height} at ${f.rect.x},${f.rect.y})`);
  }
  if (frames.length > 6) lines.push(`  ...and ${frames.length - 6} more`);
  return lines.join("\n");
}

export function sanitizeText(s: string): string {
  return s
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/</g, "(")
    .replace(/>/g, ")")
    .trim();
}
