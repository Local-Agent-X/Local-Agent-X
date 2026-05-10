import { describe, it, expect } from "vitest";
import { classifyData } from "../src/threat/classification.js";

describe("classifyData — credentials", () => {
  it("flags an Anthropic-style sk- key", () => {
    const r = classifyData("API key: sk-ant-api03-deadbeefdeadbeefdeadbeefdeadbeef");
    expect(r.labels).toContain("credentials");
  });

  it("flags a GitHub PAT prefix (ghp_)", () => {
    const r = classifyData("token=ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789");
    expect(r.labels).toContain("credentials");
  });

  it("flags a Google API key by shape (AIza + 35 chars)", () => {
    const r = classifyData("AIzaSyAbcdefghijklmnopqrstuvwxyz0123456");
    expect(r.labels).toContain("credentials");
  });

  it("flags a JWT with three base64 segments", () => {
    const r = classifyData("Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4f");
    expect(r.labels).toContain("credentials");
  });

  it("flags an inline `password=...` assignment", () => {
    const r = classifyData('config: password="hunter2hunter"');
    expect(r.labels).toContain("credentials");
  });
});

describe("classifyData — secrets", () => {
  it("flags an OpenSSH private key header", () => {
    const r = classifyData("-----BEGIN OPENSSH PRIVATE KEY-----\nfoo");
    expect(r.labels).toContain("secrets");
  });

  it("flags an RSA private key header", () => {
    const r = classifyData("-----BEGIN RSA PRIVATE KEY-----");
    expect(r.labels).toContain("secrets");
  });

  it("flags a PGP private key block", () => {
    const r = classifyData("-----BEGIN PGP PRIVATE KEY BLOCK-----");
    expect(r.labels).toContain("secrets");
  });
});

describe("classifyData — pii", () => {
  it("flags an email address", () => {
    const r = classifyData("contact: alice@example.com please");
    expect(r.labels).toContain("pii");
  });

  it("flags a US phone number with dashes", () => {
    const r = classifyData("call 555-867-5309");
    expect(r.labels).toContain("pii");
  });

  it("flags a US SSN format", () => {
    const r = classifyData("SSN 123-45-6789 on file");
    expect(r.labels).toContain("pii");
  });
});

describe("classifyData — financial", () => {
  it("flags a Visa-shaped card number", () => {
    const r = classifyData("Card: 4111111111111111");
    expect(r.labels).toContain("financial");
  });

  it("flags a space-delimited card number", () => {
    const r = classifyData("Card: 4111 1111 1111 1111");
    expect(r.labels).toContain("financial");
  });
});

describe("classifyData — internal_path", () => {
  it("flags a .ssh path", () => {
    const r = classifyData("reading from /home/user/.ssh/id_rsa");
    expect(r.labels).toContain("internal_path");
  });

  it("flags /etc/passwd reference", () => {
    const r = classifyData("cat /etc/passwd output here");
    expect(r.labels).toContain("internal_path");
  });
});

describe("classifyData — clean input", () => {
  it("returns no labels and zero confidence for benign text", () => {
    const r = classifyData("The quick brown fox jumps over the lazy dog.");
    expect(r.labels).toEqual([]);
    expect(r.confidence).toBe(0);
  });

  it("returns no labels for short numeric strings that aren't card/SSN-shaped", () => {
    const r = classifyData("count was 42 today");
    expect(r.labels).toEqual([]);
  });
});

describe("classifyData — multi-label", () => {
  it("returns all matching labels when multiple categories appear", () => {
    const r = classifyData("alice@example.com\n-----BEGIN PRIVATE KEY-----");
    expect(r.labels).toContain("pii");
    expect(r.labels).toContain("secrets");
  });

  it("reports the highest confidence among matched patterns", () => {
    // SSN is 0.95, plain email is 0.8 — SSN should drive confidence
    const r = classifyData("alice@example.com SSN 123-45-6789");
    expect(r.confidence).toBeGreaterThanOrEqual(0.95);
  });
});
