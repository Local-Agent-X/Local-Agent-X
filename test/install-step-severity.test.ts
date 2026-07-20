import { describe, expect, it } from "vitest";
import { ALL_STEPS } from "../scripts/installer/contract.mjs";
import { createReporter } from "../scripts/installer/reporter.mjs";

describe("install steps declare their own severity", () => {
  it("declares severity for every step", () => {
    expect(ALL_STEPS.filter((step) => typeof step.required !== "boolean")).toEqual([]);
  });

  it("requires only components without which there is no working app", () => {
    expect(ALL_STEPS.filter((step) => step.required).map((step) => step.id).sort())
      .toEqual(["build", "config", "desktop", "node", "npm", "posixshell"]);
  });

  it("keeps optional runtime failures nonfatal and repairable", () => {
    const output: string[] = [];
    let exitCode: number | undefined;
    const reporter = createReporter({
      ipcMode: true,
      stdout: { write: (line: string) => { output.push(line); return true; } } as NodeJS.WriteStream,
      exit: (code) => { exitCode = code; return undefined as never; },
    });
    reporter.step("ollama");
    reporter.fail("offline");
    expect(exitCode).toBeUndefined();
    expect(reporter.degraded).toEqual([{ step: "ollama", message: "offline" }]);
    expect(output.map((line) => JSON.parse(line))).toContainEqual({ type: "step", id: "ollama", state: "done" });
  });

  it("frames required failures as error plus fatal and exits nonzero", () => {
    const events: unknown[] = [];
    let exitCode: number | undefined;
    const reporter = createReporter({
      ipcMode: true,
      stdout: { write: (line: string) => { events.push(JSON.parse(line)); return true; } } as NodeJS.WriteStream,
      exit: (code) => { exitCode = code; return undefined as never; },
    });
    reporter.step("node");
    reporter.fail("old node");
    expect(exitCode).toBe(1);
    expect(events).toContainEqual({ type: "step", id: "node", state: "error", message: "old node" });
    expect(events).toContainEqual({ type: "fatal", message: "old node" });
  });
});

describe("winget source contract", () => {
  it("pins every installer winget invocation to the community source", async () => {
    const sources = await Promise.all([
      import("node:fs/promises").then(({ readFile }) => readFile("scripts/installer/prerequisite-steps.mjs", "utf8")),
      import("node:fs/promises").then(({ readFile }) => readFile("scripts/installer/node-upgrade.mjs", "utf8")),
    ]);
    const source = sources.join("\n");
    const invocations = source.match(/(?:"winget"\s*,\s*\[|`winget install)/g) || [];
    expect(invocations).toHaveLength(4);
    expect(source.match(/\.\.\.WINGET_SOURCE|WINGET_SOURCE\.join/g)).toHaveLength(4);
  });
});
