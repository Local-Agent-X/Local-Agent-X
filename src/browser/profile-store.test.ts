import { describe, it, expect, beforeEach } from "vitest";
import {
  BrowserProfileStore,
  profilePartition,
  profileUserDataDir,
  DEFAULT_PROFILE_ID,
} from "./profile-store.js";

function freshStore(): BrowserProfileStore {
  BrowserProfileStore._resetForTest();
  return BrowserProfileStore.getInstance();
}

beforeEach(() => BrowserProfileStore._resetForTest());

describe("BrowserProfileStore", () => {
  it("seeds a default profile on first run", () => {
    const store = freshStore();
    const def = store.get(DEFAULT_PROFILE_ID);
    expect(def).not.toBeNull();
    expect(def!.partition).toBe(profilePartition(DEFAULT_PROFILE_ID));
    expect(def!.userDataDir).toBe(profileUserDataDir(DEFAULT_PROFILE_ID));
  });

  it("creates a profile with derived partition + userDataDir and round-trips it", () => {
    const store = freshStore();
    const created = store.create({ name: `NutriShop ${Math.random().toString(36).slice(2, 7)}`, notes: "store logins" });
    expect(created.id).toMatch(/^prof-/);
    expect(created.partition).toBe(`persist:lax-profile-${created.id}`);
    expect(created.userDataDir).toContain(created.id);

    // Survives a singleton reset (persisted to disk).
    const reloaded = freshStore().get(created.id);
    expect(reloaded?.name).toBe(created.name);
    expect(reloaded?.notes).toBe("store logins");
  });

  it("rejects a duplicate name (case-insensitive) with PROFILE_NAME_EXISTS", () => {
    const store = freshStore();
    const name = `Dup ${Math.random().toString(36).slice(2, 7)}`;
    store.create({ name });
    expect(() => store.create({ name: name.toUpperCase() })).toThrowError(/already exists/);
    try { store.create({ name }); } catch (e) { expect((e as { code?: string }).code).toBe("PROFILE_NAME_EXISTS"); }
  });

  it("renames without changing the partition or userDataDir (logins survive)", () => {
    const store = freshStore();
    const p = store.create({ name: `Before ${Math.random().toString(36).slice(2, 7)}` });
    const renamed = store.update(p.id, { name: `After ${Math.random().toString(36).slice(2, 7)}` });
    expect(renamed?.partition).toBe(p.partition);
    expect(renamed?.userDataDir).toBe(p.userDataDir);
  });

  it("refuses to delete the default profile but allows deleting others", () => {
    const store = freshStore();
    expect(store.delete(DEFAULT_PROFILE_ID)).toBe(false);
    const p = store.create({ name: `Temp ${Math.random().toString(36).slice(2, 7)}` });
    expect(store.delete(p.id)).toBe(true);
    expect(store.get(p.id)).toBeNull();
  });

  it("returns false when deleting an unknown id", () => {
    expect(freshStore().delete("prof-does-not-exist")).toBe(false);
  });
});
