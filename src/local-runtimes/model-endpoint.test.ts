import { describe, expect, it } from "vitest";
import { isLocalModelEndpoint } from "./model-endpoint.js";

const ollamaInDocker = { localRuntimes: [{ kind: "ollama", baseUrl: "http://host.docker.internal:11434", label: "Ollama" }] };

describe("isLocalModelEndpoint", () => {
  it("is true for loopback and private-IP endpoints with no settings at all", () => {
    for (const url of ["http://127.0.0.1:11434", "http://localhost:1234/v1", "http://192.168.1.20:8000/v1", "http://[::1]:8080"]) {
      expect(isLocalModelEndpoint(url, {})).toBe(true);
    }
  });

  it("is false for a cloud endpoint and for no URL", () => {
    expect(isLocalModelEndpoint("https://api.openai.com/v1", ollamaInDocker)).toBe(false);
    expect(isLocalModelEndpoint(undefined, ollamaInDocker)).toBe(false);
  });

  // The Terminal-Bench case: a hand-added runtime reached by NAME. As a URL
  // shape it is not an IP literal, so it was treated as cloud and got no
  // output cap (2026-10-18).
  it("is true for a runtime the operator added by name, on its exact host:port", () => {
    expect(isLocalModelEndpoint("http://host.docker.internal:11434", ollamaInDocker)).toBe(true);
    expect(isLocalModelEndpoint("http://host.docker.internal:11434/v1", ollamaInDocker)).toBe(true);
  });

  it("is false for the same name without the entry, or on another port", () => {
    expect(isLocalModelEndpoint("http://host.docker.internal:11434", {})).toBe(false);
    expect(isLocalModelEndpoint("http://host.docker.internal:1234", ollamaInDocker)).toBe(false);
  });
});
