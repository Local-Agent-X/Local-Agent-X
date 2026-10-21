// A browser profile's cookie jar, saved logins, autofill store, the state
// file holding its encryption key, and the DevTools endpoint file are
// credentials at rest. The agent's own profiles were catalogued as a card
// (write-approval, read allowed) and the in-app partition under Electron's
// userData was catalogued nowhere, so under the default file-access mode the
// file tools read them (red team round 2, B-H2). They are now credential
// files to the one catalog the gate and the read-taint classifier share.
import { describe, expect, it } from "vitest";
import { classifySensitivePath } from "./sensitive-paths.js";
import { matchesSensitivePath } from "./file-access.js";
import { isSensitivePath } from "../../data-lineage/paths.js";

const STORES = [
  "C:\\Users\\u\\AppData\\Roaming\\Local Agent X\\Partitions\\lax-profile-v2\\Cookies",
  "C:\\Users\\u\\AppData\\Roaming\\Local Agent X\\Partitions\\lax-profile-v2\\Login Data",
  "C:\\Users\\u\\AppData\\Roaming\\Local Agent X\\Partitions\\lax-profile-v2\\Network\\Cookies",
  "C:\\Users\\u\\AppData\\Roaming\\Local Agent X\\DevToolsActivePort",
  "C:\\Users\\u\\.lax\\chrome-profile\\Default\\Cookies",
  "C:\\Users\\u\\.lax\\chrome-profile\\Default\\Login Data",
  "C:\\Users\\u\\.lax\\chrome-profile\\Local State",
  "C:\\Users\\u\\.lax\\browser-job-profiles\\job1\\Default\\Web Data",
  "C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Network\\Cookies",
  "C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\User Data\\Local State",
  "/home/u/.config/google-chrome/User Data/Default/Login Data",
  "/home/u/.lax/chrome-profile/Default/Cookies",
];

const NOT_STORES = [
  "C:\\Users\\u\\project\\src\\cookies.ts",
  "C:\\Users\\u\\project\\docs\\Cookies\\readme.md",
  "C:\\Users\\u\\project\\Local State.txt",
  "C:\\Users\\u\\.lax\\chrome-profile\\Default\\Bookmarks",
  "C:\\Users\\u\\.lax\\chrome-profile\\Default\\Preferences",
  "/home/u/recipes/cookies",
  "/home/u/notes/login data.md",
];

describe("a browser profile's credential stores", () => {
  it("are credential files in every classifier", () => {
    for (const p of STORES) {
      expect(classifySensitivePath(p), p).toBe(true);
      expect(matchesSensitivePath(p), p).not.toBeNull();
      expect(isSensitivePath(p), p).toBe(true);
    }
  });

  it("while a file with a similar name outside a profile tree, and a profile's bookmarks, are not", () => {
    for (const p of NOT_STORES) {
      expect(classifySensitivePath(p), p).toBe(false);
      expect(matchesSensitivePath(p), p).toBeNull();
    }
  });
});
