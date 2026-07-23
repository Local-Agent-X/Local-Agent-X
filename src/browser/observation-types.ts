/**
 * Shared observation result types — DurableRef, ObservationDegradation, and the
 * BrowserObservation shape both browser backends produce. Split out of
 * observation.ts to keep that file under the 400-LOC source ceiling; the
 * registry re-exports these so existing `from "./observation.js"` imports keep
 * working unchanged.
 */
import type { Obstruction } from "./modal-detector.js";
import type { CapturedDialog } from "./dialog-handler.js";
import type { IframeInfo } from "./iframe-detector.js";

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
  /** Set when the element lives inside a same-origin iframe. Carries the
   *  iframe's `src` URL (or "" for srcdoc / about:blank). actions.ts
   *  uses this to scope locators into the right Playwright Frame. */
  frameUrl?: string;
}

/** A sub-scan that failed during observe. The observation still returns
 *  (fail-soft), but format() must render the failure loudly — an "elements"
 *  entry means the ref list is incomplete/absent, NOT that the page is empty. */
export interface ObservationDegradation {
  op: "elements" | "obstructions" | "iframes";
  reason: string;
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
  /** Every current ref with inViewport===true, present on BOTH the initial and
   *  diff paths (unlike `full`, which is initial-only). observe.ts groups THIS
   *  into role buckets so a scroll — which adds nothing to the DOM, it just
   *  brings offscreen elements into view — still lists the controls now on
   *  screen instead of an empty diff. Optional so hand-built observations (in
   *  tests) stay valid; the registry always populates it. */
  viewport?: DurableRef[];
  /** True on a diff observation whose DOM was otherwise unchanged (nothing
   *  added/removed/changed) but whose set of in-viewport refs differs from the
   *  previous scan — i.e. the page was scrolled. Lets format() report the scroll
   *  instead of a misleading "Page unchanged". */
  viewportChanged?: boolean;
  obstructions: Obstruction[];
  dialogs: CapturedDialog[];
  crossOriginIframes: IframeInfo[];
  /** Present (non-empty) when a sub-scan failed this observation. */
  degraded?: ObservationDegradation[];
}
