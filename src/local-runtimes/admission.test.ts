import { describe, it, expect } from "vitest";

import { admitEndpoint, endpointHostPort } from "./admission.js";

const NONE: ReadonlySet<string> = new Set();

describe("endpointHostPort", () => {
  it("normalizes host:port, lowercases, strips trailing dot, defaults ports", () => {
    expect(endpointHostPort("http://127.0.0.1:11434")).toBe("127.0.0.1:11434");
    expect(endpointHostPort("http://GPUBOX.:1234")).toBe("gpubox:1234");
    expect(endpointHostPort("http://example.com")).toBe("example.com:80");
    expect(endpointHostPort("https://example.com")).toBe("example.com:443");
  });

  it("rejects non-http(s) and garbage", () => {
    expect(endpointHostPort("file:///etc/passwd")).toBeNull();
    expect(endpointHostPort("ftp://h:21")).toBeNull();
    expect(endpointHostPort("not a url")).toBeNull();
    expect(endpointHostPort("")).toBeNull();
  });
});

describe("admitEndpoint", () => {
  it("admits loopback with an empty allowlist (zero-config default)", () => {
    expect(admitEndpoint("http://127.0.0.1:11434", NONE).allowed).toBe(true);
    expect(admitEndpoint("http://localhost:1234", NONE).allowed).toBe(true);
    expect(admitEndpoint("http://[::1]:8080", NONE).allowed).toBe(true);
    expect(admitEndpoint("http://127.0.0.53:8000", NONE).allowed).toBe(true);
  });

  it("REJECTS private-range IPs that are not allowlisted — no LAN carve-out", () => {
    expect(admitEndpoint("http://192.168.1.50:11434", NONE).allowed).toBe(false);
    expect(admitEndpoint("http://10.0.0.2:1234", NONE).allowed).toBe(false);
    expect(admitEndpoint("http://172.16.0.9:8000", NONE).allowed).toBe(false);
  });

  it("admits a non-loopback endpoint ONLY on exact host:port match", () => {
    const allow: ReadonlySet<string> = new Set(["192.168.1.50:11434"]);
    expect(admitEndpoint("http://192.168.1.50:11434", allow).allowed).toBe(true);
    // same host, different port — NOT authorized
    expect(admitEndpoint("http://192.168.1.50:11435", allow).allowed).toBe(false);
    // different host, same port — NOT authorized
    expect(admitEndpoint("http://192.168.1.51:11434", allow).allowed).toBe(false);
  });

  it("rejects public hosts and invalid URLs regardless of allowlist", () => {
    expect(admitEndpoint("http://evil.example.com:11434", NONE).allowed).toBe(false);
    expect(admitEndpoint("file:///c/windows", new Set(["c:80"])).allowed).toBe(false);
  });

  it("loopback-looking hostnames do not sneak through as loopback", () => {
    // isLoopbackUrl only accepts localhost/::1/127.x — a DNS name that
    // RESOLVES to loopback is still non-loopback here (no resolution).
    expect(admitEndpoint("http://myloopback.example:11434", NONE).allowed).toBe(false);
  });
});
