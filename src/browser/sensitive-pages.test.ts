/**
 * The browserSecrecy read ladder — level × page-category matrix over the
 * classifier, the action decision, the stub, the read-grant unlock, and the
 * open-level cloud warning. Runtime config and settings are mocked so every
 * level is exercised deterministically (the real config defaults to "ask").
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserSecrecy } from "../types/lax-config.js";

const state = vi.hoisted(() => ({ level: "ask" as string, provider: "anthropic" as string }));
vi.mock("../config.js", () => ({ getRuntimeConfig: () => ({ browserSecrecy: state.level }) }));
vi.mock("../settings.js", () => ({ loadSettings: () => ({ provider: state.provider }) }));

import {
	classifySensitivePage,
	runWithSensitiveReadGrant,
	secrecyOpenWarning,
	sensitivePageActionDecision,
	sensitivePageStub,
} from "./sensitive-pages.js";

const LEVELS: BrowserSecrecy[] = ["lockdown", "guarded", "ask", "open"];
const VAULT = "https://my.1password.com/vaults/all";
const AWS = "https://console.aws.amazon.com/console/home";
const BANK = "https://chase.com/account";

beforeEach(() => {
	state.level = "ask";
	state.provider = "anthropic";
});

describe("classifySensitivePage — host authoritative at every level", () => {
	it.each([
		["cloud metadata IP", "http://169.254.169.254/latest/meta-data/", "cloud metadata"],
		["GCE metadata host", "http://metadata.google.internal/", "cloud metadata"],
		["1password host", "https://my.1password.com/vaults", "password manager"],
		["bitwarden vault host", "https://vault.bitwarden.com/", "password manager"],
		["keeper subdomain host", "https://vault.keepersecurity.com/", "password manager"],
		["aws console host", AWS, "administration panel"],
		["azure portal host", "https://portal.azure.com/", "administration panel"],
		["paypal host", "https://paypal.com/", "financial account"],
		["stripe host", "https://stripe.com/", "financial account"],
		["bank. host prefix", "https://bank.example.com/", "financial account"],
	])("classifies known sensitive host at every level: %s", (_label, url, category) => {
		for (const level of LEVELS) {
			state.level = level;
			expect(classifySensitivePage(url)?.category).toBe(category);
		}
	});

	it.each([
		["account recovery flow", "https://randomsaas.com/account-recovery/start", "account recovery"],
		["reset-password flow", "https://randomsaas.com/reset-password", "account recovery"],
		["ssh-keys page", "https://randomsaas.com/settings/ssh-keys", "private key management"],
		["private-keys page", "https://randomsaas.com/private-keys", "private key management"],
	])("classifies genuine-secret path on an arbitrary host at every level: %s", (_label, url, category) => {
		for (const level of LEVELS) {
			state.level = level;
			expect(classifySensitivePage(url)?.category).toBe(category);
		}
	});

	// The C8-dropped generic secret-ish paths return LEVEL-GATED: visible
	// outcomes only (a prompt at "ask", an explicitly-chosen "lockdown") —
	// never "guarded", whose silent withholding was the original over-match.
	it.each([
		["passwords", "https://randomsaas.com/passwords", "password manager"],
		["vault", "https://randomsaas.com/vault", "password manager"],
		["api-keys", "https://randomsaas.com/settings/api-keys", "private key management"],
		["certificates", "https://randomsaas.com/certificates", "private key management"],
	])("generic secret path classifies at ask/lockdown ONLY: %s", (_label, url, category) => {
		for (const level of ["ask", "lockdown"]) {
			state.level = level;
			expect(classifySensitivePage(url)?.category).toBe(category);
		}
		for (const level of ["guarded", "open"]) {
			state.level = level;
			expect(classifySensitivePage(url)).toBeNull();
		}
	});

	// The admin-panel / financial path groups stay dropped at EVERY level.
	it.each([
		["billing", "https://randomsaas.com/billing"],
		["payments", "https://randomsaas.com/settings/payments"],
		["admin toggle", "https://randomsaas.com/admin"],
		["management", "https://randomsaas.com/management"],
	])("generic SaaS path never classifies on an arbitrary host: %s", (_label, url) => {
		for (const level of LEVELS) {
			state.level = level;
			expect(classifySensitivePage(url)).toBeNull();
		}
	});
});

describe("sensitivePageActionDecision — secret-bearing READ ladder", () => {
	it.each([
		["lockdown", "blocked"],
		["guarded", "blocked"],
		["ask", "approval-required"],
		["open", "allow"],
	])("snapshot on a password-manager host at %s → %s", (level, disposition) => {
		state.level = level;
		expect(sensitivePageActionDecision(VAULT, "snapshot").disposition).toBe(disposition);
	});

	it("ask-level read approval carries unlocksRead (the tool layer must grant the stub unlock)", () => {
		state.level = "ask";
		const d = sensitivePageActionDecision(VAULT, "extract");
		expect(d.disposition).toBe("approval-required");
		expect(d.unlocksRead).toBe(true);
	});

	it("mutation approvals do NOT carry unlocksRead", () => {
		state.level = "ask";
		const d = sensitivePageActionDecision(VAULT, "click");
		expect(d.disposition).toBe("approval-required");
		expect(d.unlocksRead).toBeUndefined();
	});

	it("lockdown withholds reads on admin/financial pages too; other levels keep them readable", () => {
		for (const url of [AWS, BANK]) {
			state.level = "lockdown";
			expect(sensitivePageActionDecision(url, "snapshot").disposition).toBe("blocked");
			for (const level of ["guarded", "ask", "open"]) {
				state.level = level;
				expect(sensitivePageActionDecision(url, "snapshot").disposition).toBe("allow");
			}
		}
	});

	it("mutations on any sensitive page stay approval-gated below open, allowed at open", () => {
		for (const url of [VAULT, AWS, BANK]) {
			for (const level of ["lockdown", "guarded", "ask"]) {
				state.level = level;
				expect(sensitivePageActionDecision(url, "click").disposition).toBe("approval-required");
			}
			state.level = "open";
			expect(sensitivePageActionDecision(url, "click").disposition).toBe("allow");
		}
	});

	it("non-sensitive pages are untouched at every level", () => {
		for (const level of LEVELS) {
			state.level = level;
			expect(sensitivePageActionDecision("https://example.com/docs", "snapshot").disposition).toBe("allow");
			expect(sensitivePageActionDecision("https://example.com/docs", "click").disposition).toBe("allow");
		}
	});
});

describe("sensitivePageStub — level-aware withholding + read grants", () => {
	it("guarded: secret-bearing stubbed silently, admin/financial readable", () => {
		state.level = "guarded";
		expect(sensitivePageStub(VAULT)).toContain("browserSecrecy=guarded");
		expect(sensitivePageStub(AWS)).toBeNull();
		expect(sensitivePageStub(BANK)).toBeNull();
	});

	it("ask: secret-bearing stub tells the model how to trigger the approval prompt", () => {
		state.level = "ask";
		const stub = sensitivePageStub(VAULT);
		expect(stub).toContain("withheld pending approval");
		expect(stub).toContain("Re-run the read action");
		expect(sensitivePageStub(AWS)).toBeNull();
	});

	it("lockdown: ALL sensitive categories stubbed, admin/financial included", () => {
		state.level = "lockdown";
		expect(sensitivePageStub(VAULT)).toContain("browserSecrecy=lockdown");
		expect(sensitivePageStub(AWS)).toContain("browserSecrecy=lockdown");
		expect(sensitivePageStub(BANK)).toContain("browserSecrecy=lockdown");
	});

	it("open: nothing stubbed", () => {
		state.level = "open";
		expect(sensitivePageStub(VAULT)).toBeNull();
		expect(sensitivePageStub(AWS)).toBeNull();
	});

	it("an approved read grant unlocks exactly its URL, inside its own async context, across awaits", async () => {
		state.level = "ask";
		await runWithSensitiveReadGrant(VAULT, async () => {
			expect(sensitivePageStub(VAULT)).toBeNull();
			expect(sensitivePageStub("https://vault.bitwarden.com/")).not.toBeNull();
			await new Promise((r) => setTimeout(r, 0));
			expect(sensitivePageStub(VAULT)).toBeNull(); // survives async hops
		});
		expect(sensitivePageStub(VAULT)).not.toBeNull(); // dead outside the chain
	});

	it("a CONCURRENT async context (another session's dispatch) never sees the grant", async () => {
		// This is the cross-session piggyback the ALS design forecloses: while
		// session A's approved read is in flight, session B asking about the
		// same URL must still be stubbed.
		state.level = "ask";
		let seenByOther: string | null = "unset";
		const granted = runWithSensitiveReadGrant(VAULT, async () => {
			await new Promise((r) => setTimeout(r, 20));
			expect(sensitivePageStub(VAULT)).toBeNull(); // A still unlocked
		});
		const other = (async () => {
			await new Promise((r) => setTimeout(r, 5)); // mid-flight of A's grant
			seenByOther = sensitivePageStub(VAULT);
		})();
		await Promise.all([granted, other]);
		expect(seenByOther).not.toBeNull();
	});
});

describe("secrecyOpenWarning — one-time cloud-context warning at open", () => {
	it("warns once per session, naming the cloud provider, when a call ends on a secret-bearing page", () => {
		state.level = "open";
		state.provider = "anthropic";
		const first = secrecyOpenWarning("sess-warn-1", VAULT);
		expect(first).toContain("anthropic");
		expect(first).toContain("browserSecrecy=open");
		expect(secrecyOpenWarning("sess-warn-1", VAULT)).toBeNull();
		expect(secrecyOpenWarning("sess-warn-2", VAULT)).not.toBeNull();
	});

	it("is action-agnostic — landing on a vault via navigate warns too (content flows via auto-snapshots)", () => {
		state.level = "open";
		state.provider = "codex";
		expect(secrecyOpenWarning("sess-landing", "https://vault.bitwarden.com/passwords")).toContain("codex");
	});

	it("a local provider keeps contents on-box — no warning", () => {
		state.level = "open";
		for (const provider of ["ollama", "local"]) {
			state.provider = provider;
			expect(secrecyOpenWarning(`sess-local-${provider}`, VAULT)).toBeNull();
		}
	});

	it("silent below open and on non-secret-bearing pages", () => {
		state.level = "ask";
		expect(secrecyOpenWarning("sess-ask", VAULT)).toBeNull();
		state.level = "open";
		expect(secrecyOpenWarning("sess-fin", BANK)).toBeNull();
		expect(secrecyOpenWarning("sess-plain", "https://example.com/docs")).toBeNull();
	});
});
