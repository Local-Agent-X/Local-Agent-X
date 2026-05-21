import { describe, it, expect } from "vitest";
import { TOOL_CLASS_MAP } from "../ari-kernel/tool-class-map.js";
import {
  TOOL_RISK,
  classifyToolRisk,
  auditRiskCoverage,
  type ToolRisk,
} from "./risk.js";

const VALID_RISKS: ReadonlySet<ToolRisk> = new Set<ToolRisk>([
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

describe("TOOL_RISK", () => {
  it("classifies every TOOL_CLASS_MAP key", () => {
    const missing: string[] = [];
    for (const name of Object.keys(TOOL_CLASS_MAP)) {
      if (TOOL_RISK[name] === undefined) missing.push(name);
    }
    expect(missing, `unclassified tools: ${missing.join(", ")}`).toEqual([]);
  });

  it("uses only the declared ToolRisk union values", () => {
    for (const [name, risk] of Object.entries(TOOL_RISK)) {
      expect(VALID_RISKS.has(risk), `${name} has invalid risk "${risk}"`).toBe(true);
    }
  });

  it("classifies canonical high-risk tools at the expected tier", () => {
    expect(classifyToolRisk("bash")).toBe("shell");
    expect(classifyToolRisk("ari_shell")).toBe("shell");
    expect(classifyToolRisk("delete_file")).toBe("destructive");
    expect(classifyToolRisk("install_software")).toBe("destructive");
    expect(classifyToolRisk("memory_forget")).toBe("destructive");
    expect(classifyToolRisk("self_edit")).toBe("destructive");
    expect(classifyToolRisk("email_send")).toBe("external-comms");
    expect(classifyToolRisk("calendar_create_event")).toBe("external-comms");
    expect(classifyToolRisk("http_request")).toBe("network-write");
    expect(classifyToolRisk("ari_http")).toBe("network-write");
    expect(classifyToolRisk("browser")).toBe("network-read");
    expect(classifyToolRisk("web_fetch")).toBe("network-read");
    expect(classifyToolRisk("web_search")).toBe("safe");
    expect(classifyToolRisk("read")).toBe("safe");
    expect(classifyToolRisk("write")).toBe("workspace-write");
    expect(classifyToolRisk("edit")).toBe("workspace-write");
    expect(classifyToolRisk("memory_save")).toBe("workspace-write");
    expect(classifyToolRisk("memory_search")).toBe("safe");
    expect(classifyToolRisk("browser_fill_from_secret")).toBe("secrets");
    expect(classifyToolRisk("browser_capture_to_secret")).toBe("secrets");
    expect(classifyToolRisk("request_secret")).toBe("secrets");
    expect(classifyToolRisk("list_secrets")).toBe("secrets");
    expect(classifyToolRisk("sql_query")).toBe("workspace-write");
  });
});

describe("classifyToolRisk", () => {
  it("falls back to 'shell' for unknown tools (fail-safe)", () => {
    expect(classifyToolRisk("tool_that_does_not_exist_anywhere")).toBe("shell");
    expect(classifyToolRisk("")).toBe("shell");
  });
});

describe("auditRiskCoverage", () => {
  it("passes when both maps are aligned", () => {
    expect(() => auditRiskCoverage()).not.toThrow();
  });

  it("throws when a TOOL_CLASS_MAP key has no TOOL_RISK entry", () => {
    const synthetic = "__risk_test_missing__";
    (TOOL_CLASS_MAP as Record<string, string>)[synthetic] = "internal";
    try {
      expect(() => auditRiskCoverage()).toThrow(/auditRiskCoverage/);
    } finally {
      delete (TOOL_CLASS_MAP as Record<string, string>)[synthetic];
    }
  });
});
