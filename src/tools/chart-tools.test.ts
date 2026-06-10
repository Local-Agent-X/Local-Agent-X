import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chartTools } from "./chart-tools.js";

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

  it("errors on malformed series JSON", async () => {
    const r = await tool.execute({ file_path: join(dir, "x.png"), type: "bar", series: "{not json" });
    expect(r.isError).toBe(true);
  });

  it("errors on an empty/invalid spec", async () => {
    const r = await tool.execute({ file_path: join(dir, "y.png"), type: "bar", series: "[]" });
    expect(r.isError).toBe(true);
  });
});
