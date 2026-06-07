import { describe, it, expect } from "vitest";
import { stripOneDriveDocuments, isCloudStoragePath } from "./config.js";

// Regression: on Windows with OneDrive "Known Folder Move", the agent
// workspace was being placed under ...\OneDrive\Documents\Local Agent X, where
// the sync client locks files mid-write and breaks the atomic config rename.
// The workspace must map back to the real on-disk Documents.
describe("stripOneDriveDocuments", () => {
  it("drops the OneDrive segment before Documents (backslash paths)", () => {
    expect(stripOneDriveDocuments("C:\\Users\\manri\\OneDrive\\Documents\\Local Agent X"))
      .toBe("C:\\Users\\manri\\Documents\\Local Agent X");
  });

  it("handles forward-slash and trailing Documents", () => {
    expect(stripOneDriveDocuments("C:/Users/manri/OneDrive/Documents"))
      .toBe("C:/Users/manri/Documents");
  });

  it("is case-insensitive on the OneDrive segment", () => {
    expect(stripOneDriveDocuments("C:\\Users\\m\\onedrive\\Documents\\X"))
      .toBe("C:\\Users\\m\\Documents\\X");
  });

  it("leaves a non-OneDrive Documents path untouched", () => {
    const p = "C:\\Users\\manri\\Documents\\Local Agent X";
    expect(stripOneDriveDocuments(p)).toBe(p);
  });

  it("does NOT strip OneDrive when it isn't the Documents redirect (e.g. OneDrive\\Pictures)", () => {
    const p = "C:\\Users\\manri\\OneDrive\\Pictures\\foo";
    expect(stripOneDriveDocuments(p)).toBe(p);
  });
});

// macOS analogue: a workspace under a cloud-synced Documents gets its files
// evicted to dataless placeholders (blank generated media, broken atomic
// config writes), so it must relocate to local-only disk. isCloudStoragePath
// is the path-string half of detection (third-party File Providers + an
// already-resolved iCloud path); Apple's path-preserving Documents sync is
// caught separately by an inode-identity check.
describe("isCloudStoragePath", () => {
  it("matches a third-party File Provider path (~/Library/CloudStorage)", () => {
    expect(isCloudStoragePath("/Users/dad/Library/CloudStorage/OneDrive-Personal/Documents/Local Agent X"))
      .toBe(true);
  });

  it("matches a resolved iCloud CloudDocs path", () => {
    expect(isCloudStoragePath("/Users/dad/Library/Mobile Documents/com~apple~CloudDocs/Documents/Local Agent X"))
      .toBe(true);
  });

  it("leaves a plain local Documents path untouched", () => {
    expect(isCloudStoragePath("/Users/dad/Documents/Local Agent X")).toBe(false);
  });

  it("leaves the local-only ~/.lax workspace untouched", () => {
    expect(isCloudStoragePath("/Users/dad/.lax/workspace")).toBe(false);
  });
});
