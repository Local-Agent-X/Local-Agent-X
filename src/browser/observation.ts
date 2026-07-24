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
import { pendingDialogs } from "./dialog-handler.js";
import { formatDegraded, formatDialogs, formatIframes, formatObstructions, formatRef } from "./observation-format.js";
import type { DurableRef, ObservationDegradation, BrowserObservation } from "./observation-types.js";

import { createLogger } from "../logger.js";
const logger = createLogger("browser.observation");

// Observation result types (DurableRef / ObservationDegradation /
// BrowserObservation) live in observation-types.ts to keep this file under the
// 400-LOC source ceiling; re-exported so consumers still import them from
// "./observation.js".
export type { DurableRef, ObservationDegradation, BrowserObservation } from "./observation-types.js";

/**
 * Hard ceiling on a single page scan. waitForStability caps at 3s and the DOM
 * extractors are normally sub-second, so a legit observe is ~5s even on a heavy
 * page. Past this the underlying CDP call is wedged — and because each sub-op
 * below has its own `.catch()`, a wedge HANGS rather than rejects, so none of
 * those guards fire. Surface it as a typed error so the tool layer force-resets
 * the session in ~10s instead of waiting out the 30s per-tool timeout.
 */
export const OBSERVE_WEDGE_TIMEOUT_MS = 10_000;

/** Thrown when a page scan exceeds OBSERVE_WEDGE_TIMEOUT_MS — the signal that
 *  the browser session is wedged and must be reset. browser-tools catches this
 *  and calls resetWedgedBrowser(). */
export class BrowserWedgeError extends Error {
  constructor(message = "browser page scan wedged") {
    super(message);
    this.name = "BrowserWedgeError";
  }
}

/** Race `work` against the wedge ceiling. On expiry, reject with
 *  BrowserWedgeError; the abandoned `work` keeps running until the session is
 *  force-reset (its late rejection is swallowed here so it isn't unhandled).
 *  `ms` is injectable for tests. */
export async function withWedgeTimeout<T>(work: Promise<T>, ms = OBSERVE_WEDGE_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BrowserWedgeError(`page scan exceeded ${ms}ms`)), ms);
    timer.unref?.();
  });
  work.catch(() => { /* swallow the late rejection when the timeout already won */ });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Retired-ref memory cap — enough for many observation cycles on a heavy
 *  page without unbounded growth across a long session. */
const RETIRED_REF_CAP = 300;

/**
 * Ref ids are GLOBALLY unique across every ObservationRegistry in the process.
 * Each browser tab owns its own registry (in-app-tabs.ts), so a per-instance
 * counter that started (and reset) at 1 made ref numbers COLLIDE across tabs:
 * after a switch_tab, reusing an old ref like [5] would resolve against the NEW
 * tab's element #5 — a silent wrong-element click. A single module-level,
 * monotonic counter guarantees a ref number is NEVER reused by a different
 * tab/page. reset() (cross-origin nav / wedge recovery) still clears a
 * registry's refs, but the next mint draws a FRESH global id — never one seen
 * before.
 */
let nextRefId = 1;
function mintRefId(): number {
  return nextRefId++;
}

/** Lift the module counter past a persisted registry's high-water mark on
 *  restore(). Only ever RAISES the floor — lowering it would let a fresh mint
 *  reuse an id the model may still be holding from before the restart. */
function advanceRefIdFloor(highWater: number): void {
  if (highWater > nextRefId) nextRefId = highWater;
}

/**
 * TEST-ONLY: reset the module-level ref-id counter so tests that assert small
 * absolute ref numbers ([1], [2], …) stay deterministic. MUST NOT be called in
 * production — resetting the shared counter would let two registries mint
 * colliding ids, reintroducing the exact cross-tab collision it prevents.
 */
export function __resetRefIdsForTest(): void {
  nextRefId = 1;
}

export class ObservationRegistry {
  private refs = new Map<number, DurableRef>();
  private signatureToRef = new Map<string, number>();
  private observationCount = 0;
  private lastUrl = "";
  /** Tombstones for refs that dropped out of the live map: id → identity of
   *  the element it pointed at. recoverStaleRef uses these to remap a stale
   *  id the model is still holding onto after the page re-rendered. Cleared
   *  on reset() — a tombstone must never remap across an origin change or a
   *  wedge recovery, where "same role+name" can be a different control. */
  private retired = new Map<number, { signature: string; role: string; name: string }>();
  /** Bumped on every reset. A scan that was in flight when a reset happened
   *  (wedge recovery abandons the hung scan, then resets this registry) must
   *  NOT commit its stale refs over the clean state when it finally settles —
   *  observeInner checks its captured epoch before committing. */
  private epoch = 0;

  reset(): void {
    this.epoch++;
    this.refs.clear();
    this.signatureToRef.clear();
    this.retired.clear();
    // The ref-id counter is module-level and deliberately NOT reset here — a
    // ref number must never be reused after a cross-origin nav / wedge recovery
    // (nor across tabs). See mintRefId / nextRefId.
    this.observationCount = 0;
    this.lastUrl = "";
  }

  get(id: number): DurableRef | undefined {
    return this.refs.get(id);
  }

  /**
   * Remap a stale ref id to the live ref for the same logical element. When a
   * page re-renders, an element can drop out of one observation and come back
   * in the next under a NEW id — but the model may still be holding the old
   * one. Match by signature first (exact identity), then by unique role+name
   * (the element re-rendered with a changed ancestor chain). Ambiguous or
   * unknown ids return undefined — never guess between two candidates.
   */
  recoverStaleRef(id: number): DurableRef | undefined {
    const live = this.refs.get(id);
    if (live) return live;
    const t = this.retired.get(id);
    if (!t) return undefined;
    const bySignature = this.signatureToRef.get(t.signature);
    if (bySignature !== undefined) return this.refs.get(bySignature);
    let match: DurableRef | undefined;
    for (const ref of this.refs.values()) {
      if (ref.role !== t.role || ref.name !== t.name) continue;
      if (match) return undefined;
      match = ref;
    }
    return match;
  }

  private retire(ref: DurableRef): void {
    this.retired.set(ref.id, { signature: ref.signature, role: ref.role, name: ref.name });
    if (this.retired.size > RETIRED_REF_CAP) {
      for (const key of this.retired.keys()) {
        if (this.retired.size <= RETIRED_REF_CAP) break;
        this.retired.delete(key);
      }
    }
  }

  async observe(page: Page): Promise<BrowserObservation> {
    return withWedgeTimeout(this.observeInner(page));
  }

  private async observeInner(page: Page): Promise<BrowserObservation> {
    await waitForStability(page);

    const url = page.url();
    const title = await page.title().catch(() => "");
    const originChanged = safeOrigin(url) !== safeOrigin(this.lastUrl);
    if (originChanged && this.lastUrl !== "") this.reset();
    this.lastUrl = url;
    // Captured AFTER the origin-change reset so this scan's own reset doesn't
    // invalidate it — only an external reset during the awaits below does.
    const epoch = this.epoch;

    const degraded: ObservationDegradation[] = [];
    const [raw, obstructions, iframesAll] = await Promise.all([
      extractInteractiveElements(page).catch((e) => {
        logger.warn(`[observation] extractor failed: ${(e as Error).message}`);
        degraded.push({ op: "elements", reason: (e as Error).message || String(e) });
        return [] as RawElement[];
      }),
      detectObstructions(page).catch((e) => {
        logger.warn(`[observation] obstruction detector failed: ${(e as Error).message}`);
        degraded.push({ op: "obstructions", reason: (e as Error).message || String(e) });
        return [] as Obstruction[];
      }),
      listIframes(page).catch((e) => {
        degraded.push({ op: "iframes", reason: (e as Error).message || String(e) });
        return [] as IframeInfo[];
      }),
    ]);
    if (obstructions.length > 0) {
      // Observability: mark consent/cookie/modal blocks (the Guardian case) so
      // a route-around reads as a clear trail next to navigations + auth-walls.
      logger.info(`obstruction(s) detected: ${obstructions.map(o => o.kind).join(", ")} (${obstructions.length})`);
    }
    const dialogs = pendingDialogs(page);
    if (epoch !== this.epoch) {
      // The registry was reset while this scan was in flight (wedge recovery
      // abandoned it). Discard instead of committing stale refs over the clean
      // state; withWedgeTimeout already swallows this promise's rejection.
      throw new BrowserWedgeError("stale page scan discarded after registry reset");
    }
    this.observationCount++;

    const prevRefs = new Map(this.refs);
    const newRefs = new Map<number, DurableRef>();
    const added: DurableRef[] = [];
    const changed: Array<{ before: DurableRef; after: DurableRef }> = [];

    const extractFailed = degraded.some((d) => d.op === "elements");
    if (extractFailed) {
      // A failed extractor says NOTHING about the page. Committing its empty
      // list would wipe still-valid refs and render as a clean "no interactive
      // elements" page. Carry the previous refs forward untouched (raw is []
      // so the loop below is a no-op and the removal sweep finds nothing);
      // the `degraded` marker makes format() render the failure instead.
      for (const [id, ref] of prevRefs) newRefs.set(id, ref);
    }
    for (const el of raw) {
      const existingId = this.signatureToRef.get(el.signature);
      let ref: DurableRef;
      if (existingId !== undefined && prevRefs.has(existingId)) {
        const prev = prevRefs.get(existingId)!;
        ref = {
          ...prev,
          role: el.role,
          name: el.name,
          state: el.state,
          inViewport: el.inViewport,
          rect: el.rect,
          xpath: el.xpath,
          lastSeen: this.observationCount,
          ...(el.frameUrl !== undefined ? { frameUrl: el.frameUrl } : {}),
        };
        if (prev.name !== el.name || prev.role !== el.role || prev.state?.checked !== el.state?.checked) {
          changed.push({ before: prev, after: ref });
        }
      } else {
        ref = {
          id: mintRefId(),
          signature: el.signature,
          role: el.role,
          name: el.name,
          state: el.state,
          tag: el.tag,
          type: el.type,
          xpath: el.xpath,
          inViewport: el.inViewport,
          rect: el.rect,
          lastSeen: this.observationCount,
          ...(el.frameUrl !== undefined ? { frameUrl: el.frameUrl } : {}),
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
        this.retire(prev);
      }
    }

    this.refs = newRefs;
    const isInitial = this.observationCount === 1 || originChanged;
    const offscreenCount = [...newRefs.values()].filter((r) => !r.inViewport).length;
    const viewport = [...newRefs.values()].filter((r) => r.inViewport);

    // Pure viewport change (scroll): the ref set is otherwise identical (nothing
    // added / removed / changed) but a different slice is now on screen. Compare
    // the in-viewport id set against the previous scan's so format() can report
    // the scroll instead of a misleading "Page unchanged".
    const prevVisible = new Set<number>();
    for (const r of prevRefs.values()) if (r.inViewport) prevVisible.add(r.id);
    let viewportChanged = viewport.length !== prevVisible.size;
    if (!viewportChanged) {
      for (const r of viewport) { if (!prevVisible.has(r.id)) { viewportChanged = true; break; } }
    }

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
      viewport,
      viewportChanged: !isInitial && viewportChanged,
      obstructions,
      dialogs,
      crossOriginIframes: iframesAll.filter((i) => i.crossOrigin),
      ...(degraded.length > 0 ? { degraded } : {}),
    };
  }

  static format(obs: BrowserObservation): string {
    const sections: string[] = [];

    if (obs.degraded && obs.degraded.length > 0) sections.push(formatDegraded(obs.degraded));
    if (obs.dialogs.length > 0) sections.push(formatDialogs(obs.dialogs));
    if (obs.obstructions.length > 0) sections.push(formatObstructions(obs.obstructions, obs.currentRefs));
    if (obs.crossOriginIframes.length > 0) sections.push(formatIframes(obs.crossOriginIframes));

    const header = `Page: ${obs.title} — ${obs.url}`;

    if (obs.degraded?.some((d) => d.op === "elements")) {
      sections.push(`${header}\nInteractive element list unavailable — extraction failed (see notice above).`);
    } else if (obs.isInitial && obs.full) {
      const lines = obs.full.map(formatRef);
      sections.push(`${header}\n${obs.totalCount} interactive elements:\n\n${lines.join("\n")}`);
    } else if (obs.added.length === 0 && obs.removed.length === 0 && obs.changed.length === 0) {
      if (obs.viewportChanged) {
        const visibleNow = obs.totalCount - obs.offscreenCount;
        sections.push(`${header}\nViewport changed: ${visibleNow} elements now visible (scroll) — same refs still valid.`);
      } else {
        sections.push(`${header}\nPage unchanged since last observation — same refs still valid.`);
      }
    } else {
      const parts: string[] = [
        header,
        `Diff: +${obs.added.length} added, -${obs.removed.length} removed, ~${obs.changed.length} changed`,
        "",
      ];
      for (const r of obs.added) parts.push(`+ ${formatRef(r)}`);
      for (const c of obs.changed) {
        parts.push(`~ ${formatRef(c.after)}`);
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
      // The GLOBAL high-water mark (≥ every id this registry ever minted,
      // including retired ones). On restore it lifts the module counter so no
      // reused id can be re-minted after the round-trip.
      nextId: nextRefId,
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
      // A restored ref's id must never be handed out again by a later mint —
      // advance the shared counter past it even if `nextId` is stale/absent.
      advanceRefIdFloor(r.id + 1);
    }
    if (typeof s.nextId === "number") advanceRefIdFloor(s.nextId);
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

function safeOrigin(url: string): string {
  try { return new URL(url).origin; } catch { return ""; }
}

export type { RawElement };
