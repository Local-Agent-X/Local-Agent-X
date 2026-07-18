import { describe, expect, it } from "vitest";
import { buildApprovalContext } from "./approval-context.js";

describe("buildApprovalContext — browser navigate/new_tab", () => {
  it("single url renders as today", () => {
    expect(buildApprovalContext("browser", { action: "new_tab", url: "https://a.com" })).toBe(
      "Open website: https://a.com",
    );
    expect(buildApprovalContext("browser", { action: "navigate", url: "https://a.com" })).toBe(
      "Open website: https://a.com",
    );
  });

  it("urls[] renders ALL urls, not a blank summary", () => {
    const s = buildApprovalContext("browser", {
      action: "new_tab",
      urls: ["https://a.com", "https://b.com", "https://c.com"],
    });
    expect(s).toBe("Open websites: https://a.com, https://b.com, https://c.com");
  });

  it("urls[] takes precedence over url", () => {
    const s = buildApprovalContext("browser", {
      action: "new_tab",
      url: "https://ignored.com",
      urls: ["https://a.com", "https://b.com"],
    });
    expect(s).toBe("Open websites: https://a.com, https://b.com");
    expect(s).not.toContain("ignored.com");
  });

  it("urls-only call never renders the blank 'Open website: '", () => {
    const s = buildApprovalContext("browser", { action: "new_tab", urls: ["https://a.com"] });
    expect(s).not.toBe("Open website: ");
    expect(s).toContain("https://a.com");
  });

  it("huge urls list is truncated (matches the file's slice idiom)", () => {
    const urls = Array.from({ length: 40 }, (_, i) => `https://site-${i}.example.com`);
    const s = buildApprovalContext("browser", { action: "new_tab", urls });
    expect(s.length).toBeLessThanOrEqual("Open websites: ".length + 150);
  });

  it("empty urls array falls back to url", () => {
    expect(buildApprovalContext("browser", { action: "new_tab", url: "https://a.com", urls: [] })).toBe(
      "Open website: https://a.com",
    );
  });
});
