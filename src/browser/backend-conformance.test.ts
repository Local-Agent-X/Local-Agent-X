/**
 * Backend conformance (chunk G1) — the interface-drift tripwire.
 *
 * The tool layer (src/tools/browser-tools/*) drives a browser purely through
 * the BrowserBackend surface (backend.ts) and is dispatched to whichever
 * concrete backend getBrowserManager() returns — the CDP BrowserManager or the
 * ElectronInAppBackend. If either backend silently LACKS a method the tool
 * layer calls (e.g. an in-app follow-up forgets to stub `dialogDismiss`), the
 * per-backend unit suites won't catch it — each only exercises the methods it
 * chose to test. This structural test asserts BOTH prototypes carry EVERY
 * method named in the BrowserBackend contract, so a future edit that drops one
 * (or renames it on one side) fails here instead of at a user's first click.
 *
 * Pure structural — no live browser, no bridge, no CDP. It reads the contract
 * from a single source (BACKEND_METHODS, kept in lock-step with backend.ts by
 * the "every contract member is listed" cross-check below) and probes each
 * prototype with `typeof === "function"`.
 */
import { describe, expect, it } from "vitest";
import { BrowserManager } from "./manager.js";
import { ElectronInAppBackend } from "./in-app-backend.js";
import type { BrowserBackend } from "./backend.js";

// The full method surface of BrowserBackend (backend.ts). A compile-time
// mapped type below forces this list to name EXACTLY the contract's methods —
// add a method to the interface without listing it here and tsc fails the
// build; list a name the interface doesn't have and tsc fails too. So the
// runtime probe below can trust this array as the contract's shape.
const BACKEND_METHODS = [
	// Identity / state
	"getProfileId",
	"getCurrentUrl",
	"isActive",
	// Navigation / observation
	"navigate",
	"newTab",
	"snapshot",
	"observe",
	"fingerprint",
	// Interaction
	"click",
	"clickByRef",
	"clickByText",
	"fill",
	"fillByRef",
	"select",
	"scroll",
	// Page reads / tabs
	"extractText",
	"screenshot",
	"evaluate",
	"getInfo",
	"listTabs",
	"switchTab",
	"closeTab",
	// Perception
	"readConsole",
	"readNetwork",
	// Dialogs
	"dialogAccept",
	"dialogDismiss",
	// Downloads
	"getDownloads",
	"getDownloadApproval",
	"releaseDownload",
	// Lifecycle
	"close",
] as const;

// Compile-time lock: `BACKEND_METHODS[number]` must equal the set of method
// keys on BrowserBackend. If the interface gains/loses a method and this list
// isn't updated in step, one of these two aliases becomes a type error and the
// build (tsc) fails BEFORE the test runs — the list can never silently drift
// out of sync with the contract it claims to enumerate.
type BackendMethodName = {
	[K in keyof BrowserBackend]: BrowserBackend[K] extends (...args: never[]) => unknown ? K : never;
}[keyof BrowserBackend];
type Listed = (typeof BACKEND_METHODS)[number];
// Bidirectional assignability = set equality.
const _contractCoversList: Listed = "" as unknown as BackendMethodName;
const _listCoversContract: BackendMethodName = "" as unknown as Listed;
void _contractCoversList;
void _listCoversContract;

const BACKENDS: Array<{ name: string; proto: object }> = [
	{ name: "BrowserManager (CDP)", proto: BrowserManager.prototype },
	{ name: "ElectronInAppBackend (in-app)", proto: ElectronInAppBackend.prototype },
];

describe("BrowserBackend conformance — both backends implement the full contract", () => {
	it("enumerates all 30 contract methods", () => {
		// A guard on the guard: if the contract grew and BACKEND_METHODS wasn't
		// updated, the compile-time lock above already fails — but pin the count
		// so a reviewer sees the expected surface size at a glance.
		expect(BACKEND_METHODS.length).toBe(30);
		expect(new Set(BACKEND_METHODS).size).toBe(BACKEND_METHODS.length); // no dupes
	});

	for (const { name, proto } of BACKENDS) {
		describe(name, () => {
			for (const method of BACKEND_METHODS) {
				it(`implements ${method}()`, () => {
					const impl = (proto as Record<string, unknown>)[method];
					expect(
						typeof impl,
						`${name} is missing BrowserBackend.${method} — the tool layer dispatches to it`,
					).toBe("function");
				});
			}
		});
	}

	it("neither backend's prototype is missing a method the other has (symmetric surface)", () => {
		const cdp = new Set(BACKEND_METHODS.filter((m) => typeof (BrowserManager.prototype as unknown as Record<string, unknown>)[m] === "function"));
		const inApp = new Set(BACKEND_METHODS.filter((m) => typeof (ElectronInAppBackend.prototype as unknown as Record<string, unknown>)[m] === "function"));
		const onlyCdp = [...cdp].filter((m) => !inApp.has(m));
		const onlyInApp = [...inApp].filter((m) => !cdp.has(m));
		expect(onlyCdp, `contract methods only on CDP backend: ${onlyCdp.join(", ")}`).toEqual([]);
		expect(onlyInApp, `contract methods only on in-app backend: ${onlyInApp.join(", ")}`).toEqual([]);
	});
});
