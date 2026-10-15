import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chartOutPath, chartTools } from "./chart-tools.js";
import { resolveAgentPath } from "../workspace/paths.js";
import { workspaceRoot } from "../config.js";
import type { SecurityLayer } from "../security/index.js";
import { createContext } from "../tool-execution/context.js";
import { resolvePhase } from "../tool-execution/resolve-tool.js";

const tool = chartTools[0];
const dir = mkdtempSync(join(tmpdir(), "chart-tool-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const isPng = (b: Buffer) => b[0] === 0x89 && b.slice(1, 4).toString() === "PNG";

describe("create_chart", () => {
  it("renders a chart PNG to an absolute path", async () => {
    const fp = join(dir, "rev.png");
    const r = await tool.execute({
      file_path: fp, type: "bar", title: "Q3",
      categories: ["West", "East"], series: JSON.stringify([{ name: "Rev", values: [124, 98] }]),
    });
    expect(r.isError).toBeFalsy();
    expect(existsSync(fp)).toBe(true);
    expect(isPng(readFileSync(fp))).toBe(true);
    expect(r.metadata?.file_path).toBe(fp);
  });

  it("coerces a non-.png path to .png", async () => {
    const r = await tool.execute({
      file_path: join(dir, "pie"), type: "pie",
      categories: ["A", "B"], series: JSON.stringify([{ name: "s", values: [1, 2] }]),
    });
    expect(r.isError).toBeFalsy();
    expect(existsSync(join(dir, "pie.png"))).toBe(true);
  });

  it("a relative path lands under the workspace, through the canonical resolver, with .png on the NAME before resolving", () => {
    expect(chartOutPath("charts/rev", undefined)).toBe(resolveAgentPath("charts/rev.png"));
    expect(chartOutPath("workspace/charts/rev.png", undefined)).toBe(resolve(workspaceRoot(), "charts", "rev.png"));
    expect(chartOutPath("rev.PNG", undefined)).toBe(resolveAgentPath("rev.PNG"));
    expect(chartOutPath("~/rev", undefined)).toBe(resolveAgentPath("~/rev.png"));
  });

  it("the dispatcher appends .png to the arg before the path gate sees it, so the gated name is the written name", async () => {
    const ctx = createContext({
      tc: { id: "call-chart", name: "create_chart", arguments: JSON.stringify({ file_path: "charts/rev", type: "bar", series: "[]" }) },
      toolMap: new Map(),
      security: {} as SecurityLayer,
      sessionId: "chart-session",
      callContext: "local",
    });
    expect((await resolvePhase(ctx)).kind).toBe("continue");
    expect(ctx.args.file_path).toBe("charts/rev.png");
    expect(chartOutPath(String(ctx.args.file_path), undefined)).toBe(chartOutPath("charts/rev", undefined));
  });

  it("errors on malformed series JSON", async () => {
    const r = await tool.execute({ file_path: join(dir, "x.png"), type: "bar", series: "{not json" });
    expect(r.isError).toBe(true);
  });

  it("errors on an empty/invalid spec", async () => {
    const r = await tool.execute({ file_path: join(dir, "y.png"), type: "bar", series: "[]" });
    expect(r.isError).toBe(true);
  });
});
