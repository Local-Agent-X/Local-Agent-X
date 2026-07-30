import { release } from "node:os";
import type { App, Session, WebContents } from "electron";

interface ChromeIdentity {
	userAgent: string;
	acceptLanguage: string;
	platform: string;
	userAgentMetadata: {
		brands: Array<{ brand: string; version: string }>;
		fullVersionList: Array<{ brand: string; version: string }>;
		fullVersion: string;
		platform: string;
		platformVersion: string;
		architecture: string;
		model: string;
		mobile: boolean;
		bitness: string;
		wow64: boolean;
	};
}

const readyByContents = new WeakMap<WebContents, Promise<void>>();
const lifecycleWired = new WeakSet<WebContents>();
const identitySessions = new Set<Session>();
let registrarInstalled = false;
// Disabled by default while compatibility is validated against sites whose
// bot protection rejects a CDP-overridden identity. Electron's native
// Chromium identity is preferable to a partially spoofed Chrome fingerprint.
let identityOverrideEnabled = false;
const NAVIGATION_IDENTITY_DEADLINE_MS = 1_500;

function windowsPlatformVersion(osRelease: string): string {
	const build = Number(osRelease.split(".")[2] ?? 0);
	if (build >= 26100) return "19.0.0";
	if (build >= 22631) return "15.0.0";
	if (build >= 22000) return "13.0.0";
	return "10.0.0";
}

function macPlatformVersion(osRelease: string): string {
	const darwinMajor = Number(osRelease.split(".")[0] ?? 0);
	if (darwinMajor >= 25) return `${darwinMajor + 1}.0.0`;
	if (darwinMajor >= 19) return `${darwinMajor - 9}.0.0`;
	return "";
}

export function buildEmbeddedChromeIdentity(
	chromeVersion: string,
	platform = process.platform,
	architecture = process.arch,
	osRelease = release(),
): ChromeIdentity {
	const major = chromeVersion.split(".")[0];
	const isArm = architecture === "arm64";
	const bitness = architecture === "ia32" ? "32" : "64";
	const metadataArchitecture = isArm ? "arm" : "x86";
	let userAgentPlatform = "X11; Linux x86_64";
	let navigatorPlatform = "Linux x86_64";
	let metadataPlatform = "Linux";
	let platformVersion = "";
	if (platform === "win32") {
		userAgentPlatform = "Windows NT 10.0; Win64; x64";
		navigatorPlatform = "Win32";
		metadataPlatform = "Windows";
		platformVersion = windowsPlatformVersion(osRelease);
	} else if (platform === "darwin") {
		userAgentPlatform = "Macintosh; Intel Mac OS X 10_15_7";
		navigatorPlatform = "MacIntel";
		metadataPlatform = "macOS";
		platformVersion = macPlatformVersion(osRelease);
	}
	return {
		userAgent: `Mozilla/5.0 (${userAgentPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`,
		acceptLanguage: "en-US,en;q=0.9",
		platform: navigatorPlatform,
		userAgentMetadata: {
			brands: [
				{ brand: "Not_A Brand", version: "99" },
				{ brand: "Chromium", version: major },
				{ brand: "Google Chrome", version: major },
			],
			fullVersionList: [
				{ brand: "Not_A Brand", version: "99.0.0.0" },
				{ brand: "Chromium", version: chromeVersion },
				{ brand: "Google Chrome", version: chromeVersion },
			],
			fullVersion: chromeVersion,
			platform: metadataPlatform,
			platformVersion,
			architecture: metadataArchitecture,
			model: "",
			mobile: false,
			bitness,
			wow64: false,
		},
	};
}

export function ensureEmbeddedChromeIdentity(contents: WebContents): Promise<void> {
	if (!identityOverrideEnabled) return Promise.resolve();
	if (!lifecycleWired.has(contents)) {
		lifecycleWired.add(contents);
		contents.once("destroyed", () => readyByContents.delete(contents));
		contents.debugger.on("detach", () => readyByContents.delete(contents));
		contents.on("devtools-closed", () => {
			if (contents.isDestroyed()) return;
			void ensureEmbeddedChromeIdentity(contents).catch((error: unknown) => {
				console.error("[browser-identity] failed to restore embedded Chrome identity:", error);
			});
		});
	}
	const existing = readyByContents.get(contents);
	if (existing) return existing;
	const ready = Promise.resolve().then(async () => {
		if (contents.isDestroyed()) throw new Error("web contents destroyed before Chrome identity was applied");
		if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
		await contents.debugger.sendCommand(
			"Emulation.setUserAgentOverride",
			buildEmbeddedChromeIdentity(process.versions.chrome),
		);
	});
	readyByContents.set(contents, ready);
	void ready.catch(() => {
		if (readyByContents.get(contents) === ready) readyByContents.delete(contents);
	});
	return ready;
}

/** Test seam for exercising the override without enabling it in production. */
export function _setEmbeddedChromeIdentityOverrideForTest(enabled: boolean): void {
	identityOverrideEnabled = enabled;
}

/**
 * Apply the browser identity without allowing Chromium's DevTools bridge to
 * hold navigation hostage. The override improves site compatibility, but it
 * is not a prerequisite for loading a page. In particular, sendCommand can
 * remain pending when Chromium's debugger target is being recreated.
 */
export async function prepareEmbeddedChromeIdentityForNavigation(
	contents: WebContents,
	timeoutMs = NAVIGATION_IDENTITY_DEADLINE_MS,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const outcome = await Promise.race([
		ensureEmbeddedChromeIdentity(contents).then(
			() => "ready" as const,
			(error: unknown) => {
				console.warn("[browser-identity] continuing navigation without identity override:", error);
				return "failed" as const;
			},
		),
		new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), timeoutMs);
			timer.unref?.();
		}),
	]);
	if (timer) clearTimeout(timer);
	if (outcome === "timeout") {
		console.warn(`[browser-identity] identity override exceeded ${timeoutMs}ms; continuing navigation`);
	}
}

export function registerEmbeddedChromeIdentitySession(app: App, browserSession: Session): void {
	const identity = buildEmbeddedChromeIdentity(process.versions.chrome);
	// A session-level UA removes Electron's product token for compatibility
	// without forging high-entropy client hints through DevTools. The latter
	// creates a mixed fingerprint that some Akamai properties reject, while the
	// native Electron UA causes Cloudflare challenge loops.
	browserSession.setUserAgent(identity.userAgent, identity.acceptLanguage);
	identitySessions.add(browserSession);
	if (registrarInstalled) return;
	registrarInstalled = true;
	app.on("web-contents-created", (_event, contents) => {
		if (!identitySessions.has(contents.session)) return;
		void ensureEmbeddedChromeIdentity(contents).catch((error: unknown) => {
			console.error("[browser-identity] failed to apply embedded Chrome identity:", error);
		});
	});
}
