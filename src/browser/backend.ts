/**
 * BrowserBackend — the tool-facing browser contract.
 *
 * The `browser` tool (src/tools/browser-tools/*) drives a browser purely
 * through this surface: navigation, interaction, page reads, dialogs,
 * downloads, and lifecycle. The tool-layer security (sensitive-page guards,
 * download approval, egress taint, wedge/mutex) sits ABOVE this interface and
 * is therefore backend-agnostic — it survives a backend swap.
 *
 * Two concrete backends implement it:
 *   - BrowserManager (src/browser/manager.ts) — external Chrome over CDP /
 *     Playwright. The default today; the CDP fallback going forward.
 *   - ElectronInAppBackend (Phase 3) — an embedded WebContentsView the user
 *     co-drives, one per (session, profile).
 *
 * Deliberately EXCLUDES the Playwright-leaking members BrowserManager also
 * carries (`getPage`, `setPeerPages`, `listOwnedPages`, `setIdleHandler`,
 * `exportRegistry`/`importRegistry`): those hand out `Page` objects or manage
 * CDP-specific session plumbing that an in-app view has no equivalent for.
 */

import type { BrowserObservation } from "./observation.js";
import type { DownloadApprovalBinding } from "./downloads.js";
import type { BrowserEngine } from "./launcher.js";

/** Keeps ref-resolution failures distinct from successful action text. */
export interface InteractionResult { ok: boolean; text: string; }

/** Options accepted by BrowserBackend.scroll. */
export interface ScrollOptions {
  direction?: "up" | "down" | "top" | "bottom";
  refId?: number;
  amount?: number;
}

export interface BrowserBackend {
  // ── Identity / state ──
  /** The browser profile this backend is bound to (partition / userDataDir
   *  key). "default" when unassigned. */
  getProfileId(): string;
  getCurrentUrl(): string;
  isActive(): boolean;

  // ── Navigation / observation ──
  navigate(url: string, engine?: BrowserEngine): Promise<string>;
  newTab(url: string): Promise<string>;
  snapshot(): Promise<string>;
  observe(): Promise<BrowserObservation>;
  fingerprint(): Promise<string>;

  // ── Interaction ──
  click(selector: string): Promise<string>;
  clickByRef(ref: number): Promise<InteractionResult>;
  clickByText(text: string): Promise<InteractionResult>;
  fill(selector: string, value: string): Promise<string>;
  fillByRef(ref: number, value: string): Promise<InteractionResult>;
  select(selector: string, value: string): Promise<string>;
  scroll(opts: ScrollOptions): Promise<string>;

  // ── Page reads / tabs ──
  extractText(selector?: string, find?: string): Promise<string>;
  screenshot(): Promise<string>;
  evaluate(script: string): Promise<string>;
  getInfo(): Promise<string>;
  listTabs(): Promise<string>;
  switchTab(index: number): Promise<string>;

  // ── Dialogs ──
  dialogAccept(promptText?: string): Promise<string>;
  dialogDismiss(): Promise<string>;

  // ── Downloads ──
  getDownloads(): string;
  getDownloadApproval(id: string): DownloadApprovalBinding;
  releaseDownload(id: string, approved: DownloadApprovalBinding): Promise<string>;

  // ── Lifecycle ──
  close(): Promise<void>;
}
