import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAppBuildMaterializer,
  materializeAppBuild,
  type MaterializeAppBuildInput,
} from "./materialize.js";

describe("app-build staged materialization", () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `app-build-materialize-${Date.now()}-${Math.random()}`);
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function input(projectName = "project"): MaterializeAppBuildInput {
    return {
      projectDir: join(root, projectName),
      projectName: "Test",
      productMd: "# Product",
      constitutionMd: "# Constitution",
      planMd: "# Plan",
      scenarios: [{ filename: "01-happy.md", content: "# Happy" }],
      twins: [],
    };
  }

  it("rolls back a mid-materialization write failure and remains retryable", () => {
    const target = input();
    let writes = 0;
    const failing = createAppBuildMaterializer({
      writeFile(path, data) {
        writes += 1;
        if (writes === 2) throw new Error("injected write failure");
        writeFileSync(path, data);
      },
    });

    expect(() => failing(target)).toThrow("injected write failure");
    expect(existsSync(target.projectDir)).toBe(false);
    expect(readdirSync(root)).toEqual([]);

    expect(() => materializeAppBuild(target)).not.toThrow();
    expect(existsSync(join(target.projectDir, "spec", "plan.md"))).toBe(true);
  });

  it("rejects case and separator-equivalent path collisions before staging", () => {
    const target = input("collision");
    target.scenarios = [
      { filename: "Flows/Happy.md", content: "one" },
      { filename: "flows\\happy.md", content: "two" },
    ];

    expect(() => materializeAppBuild(target)).toThrow("artifact path collision");
    expect(existsSync(target.projectDir)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it("rolls back when post-write verification fails", () => {
    const target = input("verify-failure");
    const failing = createAppBuildMaterializer({
      verify: () => ({ ok: false, reason: "injected verify failure" }),
    });

    expect(() => failing(target)).toThrow("injected verify failure");
    expect(existsSync(target.projectDir)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it("cancels between writes without committing a partial project", () => {
    const target = input("cancelled");
    const controller = new AbortController();
    let writes = 0;
    const cancellable = createAppBuildMaterializer({
      writeFile(path, data) {
        writeFileSync(path, data);
        writes += 1;
        if (writes === 1) controller.abort();
      },
    });

    expect(() => cancellable({ ...target, signal: controller.signal })).toThrow();
    expect(existsSync(target.projectDir)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it("replaces an allowed existing empty directory atomically", () => {
    const target = input("existing-empty");
    mkdirSync(target.projectDir);

    materializeAppBuild(target);

    expect(existsSync(join(target.projectDir, "README.md"))).toBe(true);
  });
});
