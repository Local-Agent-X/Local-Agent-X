/**
 * "Can this machine launch Playwright's BUNDLED chromium?" — one definition,
 * two readers: doctor.ts renders it as its Playwright diagnostic row, and the
 * app_build smoke gate uses it to explain WHY a smoke was skipped. Neither owns
 * the verdict or the fix command, so they cannot drift apart.
 *
 * Read the question precisely. This is NOT "are browser tools disabled".
 * src/browser/launcher.ts drives SYSTEM Chrome first (connectOverCDP), and its
 * first Playwright fallback is launchPersistentContext({ channel: "chrome" }) —
 * system Chrome again; the bundled binary is only the THIRD fallback. So on the
 * common box (Chrome installed, `playwright install chromium` never run) every
 * browser tool works and only the bundled-chromium consumers are down. The two
 * failure modes below are therefore reported as DISTINCT reasons, and each
 * consumer states its own consequence — one boolean cannot answer both
 * questions truthfully:
 *   - "playwright-missing": the package isn't installed at all. Every launcher
 *     path is a Playwright API, so this one really does disable browser tools.
 *   - "chromium-not-downloaded": the package IS installed but
 *     `npx playwright install chromium` was never run, so there is no bundled
 *     executable to launch. This is the case that shipped app builds unverified:
 *     every import resolves and the code looks healthy right up until
 *     `chromium.launch()` throws.
 *
 * Deliberately lazy: `playwright` is only require()d when a caller asks. The
 * scenario-scorer import boundary (smoke-import.test.ts) keeps Playwright out
 * of the ordinary tool-registry boot, and a static import here would drag it
 * back in through doctor/the smoke gate.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

/** The ONE definition of how to get a browser onto this machine. Both the
 *  doctor row's `fix` and the smoke gate's user-facing warning quote this. */
export const BROWSER_INSTALL_FIX = "npm install playwright && npx playwright install chromium";

export type BrowserMissingReason = "playwright-missing" | "chromium-not-downloaded";

export type BrowserAvailability =
  | { available: true }
  /** `message` states only WHAT is missing. The CONSEQUENCE differs per
   *  consumer (see the header), so each one phrases that itself off `reason`. */
  | { available: false; reason: BrowserMissingReason; message: string };

/**
 * Test seams. Injected only by the probe's own unit test, which must be able to
 * drive all four branches on any machine — including this one, whose real
 * answer is a single fixed value. Production passes nothing.
 */
export interface BrowserProbeDeps {
  /** Resolve a module id; throws exactly as require.resolve does when absent. */
  resolveModule?: (id: string) => string;
  /** Load playwright. May throw; the structural type keeps the `playwright`
   *  reference type-position-only so nothing is imported eagerly. */
  loadPlaywright?: () => { chromium: { executablePath: () => string } };
  /** Does this path exist on disk? */
  fileExists?: (path: string) => boolean;
}

/**
 * Probe, in the order the failures actually occur: is the package resolvable,
 * and does the chromium executable it points at exist on disk? Asking
 * Playwright itself for the path (rather than guessing at its browsers
 * directory) keeps this honest across Playwright's own layout changes.
 */
export function probeBrowserAvailability(deps: BrowserProbeDeps = {}): BrowserAvailability {
  const resolveModule = deps.resolveModule ?? ((id: string) => require.resolve(id));
  const loadPlaywright = deps.loadPlaywright ?? (() => require("playwright") as typeof import("playwright"));
  const fileExists = deps.fileExists ?? existsSync;
  try {
    resolveModule("playwright");
  } catch {
    return { available: false, reason: "playwright-missing", message: "Playwright is not installed" };
  }
  try {
    const path = loadPlaywright().chromium.executablePath();
    if (path && fileExists(path)) return { available: true };
  } catch {
    // executablePath() throws when Playwright's registry has no chromium entry
    // at all — same user-visible situation as a path that isn't on disk.
  }
  return {
    available: false,
    reason: "chromium-not-downloaded",
    message: "Playwright is installed, but its bundled chromium was never downloaded",
  };
}
