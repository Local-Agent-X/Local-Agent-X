import { describe, it, expect } from "vitest";
import {
  TOOL_CLASS_MAP,
  TOOL_AUTONOMY_RISK,
  classifyAutonomy,
  type AutonomyRisk,
} from "./tool-class-map.js";
import { auditAutonomyCoverage } from "./coverage.js";

const VALID_RISKS: ReadonlySet<AutonomyRisk> = new Set<AutonomyRisk>([
  "safe",
  "workspace-write",
  "network-read",
  "network-write",
  "shell",
  "destructive",
  "money",
  "external-comms",
  "secrets",
]);

describe("TOOL_AUTONOMY_RISK", () => {
  it("classifies every TOOL_CLASS_MAP key", () => {
    const missing: string[] = [];
    for (const name of Object.keys(TOOL_CLASS_MAP)) {
      if (TOOL_AUTONOMY_RISK[name] === undefined) missing.push(name);
    }
    expect(missing, `unclassified tools: ${missing.join(", ")}`).toEqual([]);
  });

  it("uses only the declared AutonomyRisk union values", () => {
    for (const [name, risk] of Object.entries(TOOL_AUTONOMY_RISK)) {
      expect(VALID_RISKS.has(risk), `${name} has invalid risk "${risk}"`).toBe(true);
    }
  });

  it("matches kernel-class hints for canonical examples", () => {
    expect(classifyAutonomy("bash")).toBe("shell");
    expect(classifyAutonomy("ari_shell")).toBe("shell");
    expect(classifyAutonomy("delete_file")).toBe("destructive");
    expect(classifyAutonomy("install_software")).toBe("destructive");
    expect(classifyAutonomy("email_send")).toBe("external-comms");
    expect(classifyAutonomy("calendar_create_event")).toBe("external-comms");
    expect(classifyAutonomy("browser")).toBe("network-read");
    expect(classifyAutonomy("http_request")).toBe("network-write");
    expect(classifyAutonomy("web_search")).toBe("safe");
    expect(classifyAutonomy("memory_save")).toBe("workspace-write");
    expect(classifyAutonomy("memory_search")).toBe("safe");
    expect(classifyAutonomy("browser_fill_from_secret")).toBe("secrets");
    expect(classifyAutonomy("request_secret")).toBe("secrets");
    expect(classifyAutonomy("sql_query")).toBe("workspace-write");
    expect(classifyAutonomy("read")).toBe("safe");
  });
});

describe("classifyAutonomy", () => {
  it("falls back to 'shell' for unknown tools (fail-safe)", () => {
    expect(classifyAutonomy("tool_that_does_not_exist_anywhere")).toBe("shell");
    expect(classifyAutonomy("")).toBe("shell");
  });
});

describe("auditAutonomyCoverage", () => {
  it("passes when both maps are aligned", () => {
    expect(() => auditAutonomyCoverage()).not.toThrow();
  });

  it("throws when a TOOL_CLASS_MAP key has no autonomy entry", () => {
    const synthetic = "__autonomy_test_missing__";
    (TOOL_CLASS_MAP as Record<string, string>)[synthetic] = "internal";
    try {
      expect(() => auditAutonomyCoverage()).toThrow(/auditAutonomyCoverage/);
    } finally {
      delete (TOOL_CLASS_MAP as Record<string, string>)[synthetic];
    }
  });
});
