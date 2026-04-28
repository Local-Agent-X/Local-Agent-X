/**
 * Browser observation layer — durable refs, diffs, viewport filtering, and
 * obstruction/dialog/iframe surfacing.
 *
 * Refs are stable across observations: an element keeps its [N] across many
 * snapshots as long as its role + name + ancestor chain doesn't change. Output
 * is a diff after the first observation. Critically, anything that BLOCKS
 * normal interaction (modals, native dialogs, OAuth iframes) is surfaced at
 * the TOP of the formatted output so the agent can't ignore it.
 */
import type { Page } from "playwright";
import { extractInteractiveElements, type RawElement } from "./extract.js";
import { waitForStability } from "./stability.js";
import { detectObstructions, type Obstruction } from "./modal-detector.js";
import { listIframes, type IframeInfo } from "./iframe-detector.js";
import { pendingDialogs, type CapturedDialog } from "./dialog-handler.js";

import { createLogger } from "../logger.js";
const logger = createLogger("browser.observation");

export interface DurableRef {
  id: number;
  signature: string;
  role: string;
  name: string;
  tag: string;
  type: string;
  xpath: string;
  inViewport: boolean;
  lastSeen: number;
  rect: { x: number; y: number; width: number; height: number };
}

export interface BrowserObservation {
  url: string;
  title: string;
  isInitial: boolean;
  full?: DurableRef[];
  added: DurableRef[];
  removed: DurableRef[];
  changed: Array<{ before: DurableRef; after: DurableRef }>;
  offscreenCount: number;
  totalCount: number;
  /** All current refs — used by format() to resolve obstruction button XPaths to refs. */
  currentRefs: DurableRef[];
  obstructions: Obstruction[];
  dialogs: CapturedDialog[];
  crossOriginIframes: IframeInfo[];
}

export class ObservationRegistry {
  private refs = new Map<number, DurableRef>();
  private signatureToRef = new Map<string, number>();
  private nextId = 1;
  private observationCount = 0;
  private lastUrl = "";

  reset(): void {
    this.refs.clear();
    this.signatureToRef.clear();
    this.nextId = 1;
    this.observationCount = 0;
    this.lastUrl = "";
  }

  get(id: number): DurableRef | undefined {
    return this.refs.get(id);
  }

  async observe(page: Page): Promise<BrowserObservation> {
    await waitForStability(page);

    const url = page.url();
    const title = await page.title().catch(() => "");
    const originChanged = safeOrigin(url) !== safeOrigin(this.lastUrl);
    if (originChanged && this.lastUrl !== "") this.reset();
    this.lastUrl = url;

    const [raw, obstructions, iframesAll] = await Promise.all([
      extractInteractiveElements(page).catch((e) => {
        logger.warn(`[observation] extractor failed: ${(e as Error).message}`);
        return [] as RawElement[];
      }),
      detectObstructions(page).catch((e) => {
        logger.warn(`[observation] obstruction detector failed: ${(e as Error).message}`);
        return [] as Obstruction[];
      }),
      listIframes(page).catch(() => [] as IframeInfo[]),
    ]);
    const dialogs = pendingDialogs(page);
    this.observationCount++;

    const prevRefs = new Map(this.refs);
    const newRefs = new Map<number, DurableRef>();
    const added: DurableRef[] = [];
    const changed: Array<{ before: DurableRef; after: DurableRef }> = [];

    for (const el of raw) {
      const existingId = this.signatureToRef.get(el.signature);
      let ref: DurableRef;
      if (existingId !== undefined && prevRefs.has(existingId)) {
        const prev = prevRefs.get(existingId)!;
        ref = {
          ...prev,
          role: el.role,
          name: el.name,
          inViewport: el.inViewport,
          rect: el.rect,
          xpath: el.xpath,
          lastSeen: this.observationCount,
        };
        if (prev.name !== el.name || prev.role !== el.role) {
          changed.push({ before: prev, after: ref });
        }
      } else {
        ref = {
          id: this.nextId++,
          signature: el.signature,
          role: el.role,
          name: el.name,
          tag: el.tag,
          type: el.type,
          xpath: el.xpath,
          inViewport: el.inViewport,
          rect: el.rect,
          lastSeen: this.observationCount,
        };
        this.signatureToRef.set(el.signature, ref.id);
        added.push(ref);
      }
      newRefs.set(ref.id, ref);
    }

    const removed: DurableRef[] = [];
    for (const [id, prev] of prevRefs) {
      if (!newRefs.has(id)) {
        removed.push(prev);
        this.signatureToRef.delete(prev.signature);
      }
    }

    this.refs = newRefs;
    const isInitial = this.observationCount === 1 || originChanged;
    const offscreenCount = [...newRefs.values()].filter((r) => !r.inViewport).length;

    return {
      url,
      title,
      isInitial,
      full: isInitial ? [...newRefs.values()] : undefined,
      added: isInitial ? [] : added,
      removed: isInitial ? [] : removed,
      changed: isInitial ? [] : changed,
      offscreenCount,
      totalCount: newRefs.size,
      currentRefs: [...newRefs.values()],
      obstructions,
      dialogs,
      crossOriginIframes: iframesAll.filter((i) => i.crossOrigin),
    };
  }

  static format(obs: BrowserObservation): string {
    const sections: string[] = [];

    if (obs.dialogs.length > 0) sections.push(formatDialogs(obs.dialogs));
    if (obs.obstructions.length > 0) sections.push(formatObstructions(obs.obstructions, obs.currentRefs));
    if (obs.crossOriginIframes.length > 0) sections.push(formatIframes(obs.crossOriginIframes));

    const header = `Page: ${obs.title} — ${obs.url}`;

    if (obs.isInitial && obs.full) {
      const lines = obs.full.map(formatRef);
      sections.push(`${header}\n${obs.totalCount} interactive elements:\n\n${lines.join("\n")}`);
    } else if (obs.added.length === 0 && obs.removed.length === 0 && obs.changed.length === 0) {
      sections.push(`${header}\nPage unchanged since last observation — same refs still valid.`);
    } else {
      const parts: string[] = [
        header,
        `Diff: +${obs.added.length} added, -${obs.removed.length} removed, ~${obs.changed.length} changed`,
        "",
      ];
      for (const r of obs.added) parts.push(`+ ${formatRef(r)}`);
      for (const c of obs.changed) {
        parts.push(`~ [${c.after.id}]<${c.after.role}> "${c.before.name}" → "${c.after.name}"`);
      }
      for (const r of obs.removed) parts.push(`- [${r.id}]<${r.role}> "${r.name}"`);
      sections.push(parts.join("\n"));
    }

    return sections.join("\n\n");
  }

  static formatRef = formatRef;

  serialize(): SerializedRegistry {
    return {
      refs: [...this.refs.values()],
      nextId: this.nextId,
      observationCount: this.observationCount,
      lastUrl: this.lastUrl,
    };
  }

  restore(state: unknown): void {
    if (!state || typeof state !== "object") return;
    const s = state as Partial<SerializedRegistry>;
    if (!Array.isArray(s.refs)) return;
    this.refs.clear();
    this.signatureToRef.clear();
    for (const r of s.refs) {
      this.refs.set(r.id, r);
      this.signatureToRef.set(r.signature, r.id);
    }
    this.nextId = typeof s.nextId === "number" ? s.nextId : this.nextId;
    this.observationCount = typeof s.observationCount === "number" ? s.observationCount : 0;
    this.lastUrl = typeof s.lastUrl === "string" ? s.lastUrl : "";
  }
}

export interface SerializedRegistry {
  refs: DurableRef[];
  nextId: number;
  observationCount: number;
  lastUrl: string;
}

function formatRef(r: DurableRef): string {
  const safeName = sanitizeText(r.name).slice(0, 80);
  const safeRole = (r.role || r.tag.toLowerCase()).replace(/[\r\n<>]/g, "").slice(0, 20);
  const typeAttr = r.type ? ` type=${r.type.replace(/[\r\n<>]/g, "").slice(0, 16)}` : "";
  const offBadge = r.inViewport ? "" : " [offscreen]";
  return `[${r.id}]<${safeRole}${typeAttr}>${safeName}</${safeRole}>${offBadge}`;
}

function formatDialogs(dialogs: CapturedDialog[]): string {
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

function formatObstructions(obstructions: Obstruction[], refs: DurableRef[]): string {
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

function formatIframes(frames: IframeInfo[]): string {
  const lines: string[] = ["== IFRAMES (cross-origin — refs do NOT reach inside; use evaluate or interact with the container) =="];
  for (const f of frames.slice(0, 6)) {
    lines.push(`  ${f.origin} (${f.rect.width}×${f.rect.height} at ${f.rect.x},${f.rect.y})`);
  }
  if (frames.length > 6) lines.push(`  ...and ${frames.length - 6} more`);
  return lines.join("\n");
}

function sanitizeText(s: string): string {
  return s
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/</g, "(")
    .replace(/>/g, ")")
    .trim();
}

function safeOrigin(url: string): string {
  try { return new URL(url).origin; } catch { return ""; }
}

export type { RawElement };
