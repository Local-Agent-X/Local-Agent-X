// F1 migration seam: the "default" profile's CDP userDataDir ALIASES the legacy
// shared dir (<laxDir>/chrome-profile) so users upgrading into the profiles
// world keep their existing CDP logins; every other profile gets its own
// <laxDir>/browser-profiles/<id>. This must hold across THREE consumers at once
// — the store seed, the CDP launch (manager.ts), and the clear route's canonical
// comparison (routes/browser/profiles.ts) — so it is derived in ONE place
// (profileUserDataDir) and asserted here.
//
// The dir constants bind at module load from LAX_DATA_DIR, so we relocate the
// data dir to a temp path BEFORE importing the module (dynamic import after the
// env assignment — same trick route-browser-profiles-clear.test.ts uses for its
// mocks).
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_DATA_DIR = process.env.LAX_DATA_DIR;
const DATA_DIR = mkdtempSync(join(tmpdir(), "lax-profile-store-"));
process.env.LAX_DATA_DIR = DATA_DIR;

const { BrowserProfileStore, profileUserDataDir, profilePartition, DEFAULT_PROFILE_ID } =
	await import("./profile-store.js");

const PROFILES_FILE = join(DATA_DIR, "browser-profiles.json");
const LEGACY_DIR = join(DATA_DIR, "chrome-profile");

interface RawProfile {
	id: string;
	name: string;
	partition: string;
	userDataDir: string;
	createdAt: number;
	lastUsedAt: number;
}

function seedFile(profiles: RawProfile[]): void {
	writeFileSync(PROFILES_FILE, JSON.stringify(profiles), "utf-8");
}

function readFile(): RawProfile[] {
	return JSON.parse(readFileSync(PROFILES_FILE, "utf-8"));
}

beforeEach(() => {
	BrowserProfileStore._resetForTest();
	if (existsSync(PROFILES_FILE)) rmSync(PROFILES_FILE);
});

afterAll(() => {
	rmSync(DATA_DIR, { recursive: true, force: true });
	if (ORIGINAL_DATA_DIR === undefined) delete process.env.LAX_DATA_DIR;
	else process.env.LAX_DATA_DIR = ORIGINAL_DATA_DIR;
});

describe("profileUserDataDir — default aliases the legacy shared dir", () => {
	it("resolves the DEFAULT profile to the legacy <laxDir>/chrome-profile dir", () => {
		expect(profileUserDataDir(DEFAULT_PROFILE_ID)).toBe(LEGACY_DIR);
	});

	it("resolves any NON-default profile to its own browser-profiles/<id> dir", () => {
		expect(profileUserDataDir("work")).toBe(join(DATA_DIR, "browser-profiles", "work"));
		expect(profileUserDataDir("prof-abc")).toBe(join(DATA_DIR, "browser-profiles", "prof-abc"));
	});

	it("never routes a non-default profile through the legacy dir", () => {
		expect(profileUserDataDir("work")).not.toBe(LEGACY_DIR);
		expect(profileUserDataDir(DEFAULT_PROFILE_ID)).not.toBe(profileUserDataDir("work"));
	});
});

describe("BrowserProfileStore — default profile seed + migration", () => {
	it("seeds a fresh default profile with the legacy userDataDir", () => {
		const store = BrowserProfileStore.getInstance();
		const def = store.get(DEFAULT_PROFILE_ID);
		expect(def?.userDataDir).toBe(LEGACY_DIR);
		expect(def?.partition).toBe(profilePartition(DEFAULT_PROFILE_ID));
	});

	it("migrates a pre-F1 default record (browser-profiles/default) to the legacy dir and persists it", () => {
		// Simulate an install from before the alias existed.
		const stale = join(DATA_DIR, "browser-profiles", "default");
		seedFile([
			{ id: "default", name: "Default", partition: profilePartition("default"), userDataDir: stale, createdAt: 1, lastUsedAt: 1 },
		]);

		const store = BrowserProfileStore.getInstance();
		expect(store.get("default")?.userDataDir).toBe(LEGACY_DIR);
		// The heal is durable — re-read from disk.
		expect(readFile().find((p) => p.id === "default")?.userDataDir).toBe(LEGACY_DIR);
	});

	it("leaves a non-default profile's userDataDir untouched during migration", () => {
		const workDir = join(DATA_DIR, "browser-profiles", "work");
		seedFile([
			{ id: "default", name: "Default", partition: profilePartition("default"), userDataDir: join(DATA_DIR, "browser-profiles", "default"), createdAt: 1, lastUsedAt: 1 },
			{ id: "work", name: "Work", partition: profilePartition("work"), userDataDir: workDir, createdAt: 1, lastUsedAt: 1 },
		]);

		const store = BrowserProfileStore.getInstance();
		expect(store.get("work")?.userDataDir).toBe(workDir);
	});

	it("keeps the clear route's canonical guard TRUE for the healed default (profile.userDataDir === profileUserDataDir(id))", () => {
		seedFile([
			{ id: "default", name: "Default", partition: profilePartition("default"), userDataDir: join(DATA_DIR, "browser-profiles", "default"), createdAt: 1, lastUsedAt: 1 },
		]);
		const store = BrowserProfileStore.getInstance();
		const def = store.get("default")!;
		// This is exactly the equality clearProfileData() checks before rm.
		expect(def.userDataDir).toBe(profileUserDataDir(def.id));
	});
});
