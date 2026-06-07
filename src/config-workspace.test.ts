import { describe, it, expect } from "vitest";
import { stripOneDriveDocuments } from "./config.js";

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
