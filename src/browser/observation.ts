/**
 * Browser observation layer — durable refs, diffs, viewport filtering.
 *
 * Unlike a plain snapshot that reassigns refs every call, this layer tracks
 * elements across observations via a signature (role + accessible name +
 * structural path). A stable element keeps its ref [5] across 20 observations.
 *
 * Output is a diff after the first observation: + added, - removed, ~ changed.
 * Elements outside the viewport are summarized (count) rather than listed
 * line-by-line, so long pages don't blow up token cost.
 */
import type { Page } from "playwright";
import { extractInteractiveElements, type RawElement } from "./extract.js";
import { waitForStability } from "./stability.js";

import { createLogger } from "../logger.js";
const logger = createLogger("browser.observation");

/** Durable ref — persistent across observations while the element exists. */
export interface DurableRef {
  id: number;
  signature: string;
  role: string;
  name: string;
  tag: string;
  type: string;
  xpath: string;
  inViewport: boolean;
  /** Last seen observation count — used to expire stale refs. */
  lastSeen: number;
  /** Bounding rect — for viewport checks and coord-click fallback. */
  rect: { x: number; y: number; width: number; height: number };
}

/** Result of an observe() call. */
export interface BrowserObservation {
  url: string;
  title: string;
  /** Was this the first observation for this URL? If so, `full` is populated. */
  isInitial: boolean;
  /** Full element list (only on isInitial=true). */
  full?: DurableRef[];
  /** Added since last observation. */
  added: DurableRef[];
  /** Removed since last observation. */
  removed: DurableRef[];
  /** Name/state changed since last observation. */
  changed: Array<{ before: DurableRef; after: DurableRef }>;
  /** Count of refs outside the current viewport (not listed to save tokens). */
  offscreenCount: number;
  /** Total element count (in + out of viewport). */
  totalCount: number;
}

/** Registry of durable refs — one per BrowserManager instance. */
export class ObservationRegistry {
  private refs = new Map<number, DurableRef>();
  private signatureToRef = new Map<string, number>();
  private nextId = 1;
  private observationCount = 0;
  private lastUrl = "";

  /** Clear all state (used on navigate to a genuinely different origin). */
  reset(): void {
    this.refs.clear();
    this.signatureToRef.clear();
    this.nextId = 1;
    this.observationCount = 0;
    this.lastUrl = "";
  }

  /** Lookup by ref id (resolves a click/fill target). */
  get(id: number): DurableRef | undefined {
    return this.refs.get(id);
  }

  /**
   * Run a fresh observation against the page and diff against prior state.
   * Returns the diff. Updates internal registry so refs persist next call.
   */
  async observe(page: Page): Promise<BrowserObservation> {
    await waitForStability(page);

    const url = page.url();
    const title = await page.title().catch(() => "");
    // If navigating to a brand-new origin, reset so we don't accumulate cross-site refs.
    const originChanged = safeOrigin(url) !== safeOrigin(this.lastUrl);
    if (originChanged && this.lastUrl !== "") this.reset();
    this.lastUrl = url;

    const raw = await extractInteractiveElements(page).catch((e) => {
      logger.warn(`[observation] extractor failed: ${(e as Error).message}`);
      return [] as RawElement[];
    });
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
    };
  }

  /**
   * Format an observation for the LLM using the browser-use-style compact
   * element listing: `[N]<tag>text</tag>`. This is the format research shows
   * performs best — short, stable, LLM-friendly. The model references elements
   * by their stable [N] id; the runtime resolves selectors at action time.
   */
  static format(obs: BrowserObservation): string {
    const header = `Page: ${obs.title} — ${obs.url}`;

    if (obs.isInitial && obs.full) {
      const lines = obs.full.map(formatRef);
      return `${header}\n${obs.totalCount} interactive elements:\n\n${lines.join("\n")}`;
    }

    if (obs.added.length === 0 && obs.removed.length === 0 && obs.changed.length === 0) {
      return `${header}\nPage unchanged since last observation — same refs still valid.`;
    }

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
    return parts.join("\n");
  }

  /** Format a single ref as "[id] role \"name\" (type)". */
  static formatRef = formatRef;

  /**
   * Serialize registry state so it can be passed to a sub-agent or persisted
   * in an Operation's sharedState. The receiver can call restore() to pick up
   * where we left off — same refs, same mappings.
   */
  serialize(): SerializedRegistry {
    return {
      refs: [...this.refs.values()],
      nextId: this.nextId,
      observationCount: this.observationCount,
      lastUrl: this.lastUrl,
    };
  }

  /** Hydrate registry state produced by serialize(). Safe to call on empty. */
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
  // Compact element line: [N]<role>text</role>
  //   [47]<button>Submit</button>
  //   [12]<textbox type=email>Email address</textbox>
  //   [89]<link>Professional dashboard</link> [offscreen]
  // Stable refs, scannable by the LLM, close to the browser-use format.
  const safeName = r.name
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/</g, "(")
    .replace(/>/g, ")")
    .slice(0, 80);
  const safeRole = (r.role || r.tag.toLowerCase()).replace(/[\r\n<>]/g, "").slice(0, 20);
  const typeAttr = r.type ? ` type=${r.type.replace(/[\r\n<>]/g, "").slice(0, 16)}` : "";
  const offBadge = r.inViewport ? "" : " [offscreen]";
  return `[${r.id}]<${safeRole}${typeAttr}>${safeName}</${safeRole}>${offBadge}`;
}

function safeOrigin(url: string): string {
  try { return new URL(url).origin; } catch { return ""; }
}

export type { RawElement };
