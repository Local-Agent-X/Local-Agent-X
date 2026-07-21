import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const LOOP_DIR = fileURLToPath(new URL(".", import.meta.url));
const FORBIDDEN_BACKEND_IMPORTS = [
  "./turn-loop.js",
  "./tool-dispatch.js",
  "./chat-tool-dispatcher.js",
  "../tool-execution/",
];

describe("execution backend interface seal", () => {
  it("keeps loop and dispatcher ownership outside execution backends", () => {
    const files = readdirSync(LOOP_DIR)
      .filter((name) => name.endsWith("execution-backend.ts"));
    const violations: string[] = [];

    for (const name of files) {
      const source = readFileSync(join(LOOP_DIR, name), "utf8");
      for (const forbidden of FORBIDDEN_BACKEND_IMPORTS) {
        if (source.includes(forbidden)) violations.push(`${name} imports ${forbidden}`);
      }
      if (/\.runTurn\s*\(/.test(source)) violations.push(`${name} drives adapter.runTurn`);
      if (/\bdriveTurn\s*\(/.test(source)) violations.push(`${name} drives the canonical turn loop`);
      if (/\bdispatch(?:Tool|Batch|Call)s?\s*\(/.test(source)) violations.push(`${name} dispatches tools`);
    }

    expect(violations).toEqual([]);
  });

  it("keeps placement admission out of the parity-only backend seam", () => {
    const contract = readFileSync(join(LOOP_DIR, "execution-backend.ts"), "utf8");
    const inProcess = readFileSync(join(LOOP_DIR, "in-process-execution-backend.ts"), "utf8");
    const scheduler = readFileSync(join(LOOP_DIR, "scheduler.ts"), "utf8");

    expect(contract).not.toMatch(/\badmit(?:ted|sion)?\b/i);
    expect(inProcess).not.toMatch(/\badmit(?:ted|sion)?\b/i);
    expect(scheduler).not.toMatch(/backend\.admit\s*\(/);
  });

  it("keeps scheduler dispatch behind the built-in backend", () => {
    const importers: string[] = [];
    for (const entry of readdirSync(LOOP_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
      const source = readFileSync(join(LOOP_DIR, entry.name), "utf8");
      if (source.includes('from "./worker.js"')) importers.push(basename(entry.name));
    }
    expect(importers.sort()).toEqual(["index.ts", "scheduler.ts"].sort());
    const scheduler = readFileSync(join(LOOP_DIR, "scheduler.ts"), "utf8");
    expect(scheduler).not.toMatch(/\brunWorker\s*\(/);
  });

  it("makes the production adapter-construction boundary explicit", () => {
    const contract = readFileSync(join(LOOP_DIR, "execution-backend.ts"), "utf8");
    const inProcess = readFileSync(join(LOOP_DIR, "in-process-execution-backend.ts"), "utf8");
    expect(contract).toContain('"parent" | "backend"');
    expect(inProcess).toContain('adapterProvisioning = "parent"');
    expect(inProcess).toContain("requires a live adapter");
  });
});
