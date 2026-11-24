/**
 * The agent sees the deck it made before it says it is done. Until
 * 2026-11-23 the only preview needed LibreOffice; without it the agent
 * delivered a pitch deck of twelve white slides it had never looked at.
 * Now every deck the presentation tool writes comes back rendered, inline
 * in the result, with what the checks found.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { presentationTools } from "./presentation-tools.js";

const dir = mkdtempSync(join(tmpdir(), "lax-deck-preview-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const presentation = presentationTools[0];
const run = (args: Record<string, unknown>) => presentation.execute(args, new AbortController().signal);

describe("presentation create shows the agent its deck", () => {
  it("returns the rendered slides inline and says the check passed", async () => {
    const file = join(dir, "good.pptx");
    const r = await run({
      action: "create", file_path: file,
      slides: JSON.stringify([
        { layout: "title", title: "Quarterly review", body: "Where we are" },
        { layout: "stats", title: "Numbers", stats: [{ value: "12%", label: "growth" }] },
        { layout: "closing", title: "Thank you" },
      ]),
    });
    expect(r.isError).toBeFalsy();
    expect(existsSync(file)).toBe(true);
    expect(r._images?.length).toBe(1);
    expect(r._images![0]).toMatchObject({ mime: "image/jpeg" });
    expect(Buffer.from(r._images![0].b64, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(r.content).toMatch(/Slide check: no overflow/);
    expect(r.content).toMatch(/rendered slides are shown to you/);
    expect(r.metadata?.slide_findings).toEqual([]);
  });

  it("makes the deck in the design the agent named, and says which", async () => {
    const r = await run({
      action: "create", file_path: join(dir, "legal.pptx"), design: "ledger",
      slides: JSON.stringify([{ layout: "title", title: "Compliance review" }, { layout: "closing", title: "Questions" }]),
    });
    expect(r.metadata?.design).toBe("ledger");
    expect(r.content).toMatch(/Design: ledger\./);
  });

  it("hands the agent the purpose's playbook to review the slides against", async () => {
    const r = await run({
      action: "create", file_path: join(dir, "pitch.pptx"), purpose: "pitch",
      slides: JSON.stringify([{ layout: "title", title: "Acme" }, { layout: "closing", title: "Raising $1M" }]),
    });
    expect(r.content).toMatch(/Review the slides against the pitch playbook \(deck-pitch\)/);
    expect(r.content).toMatch(/Pitch deck playbook/);
    expect(r.metadata?.purpose).toBe("pitch");
    expect(["midnight", "signal", "harbor"]).toContain(r.metadata?.design);
  });

  it("names the problems it found, so the agent fixes them before replying", async () => {
    const r = await run({
      action: "create", file_path: join(dir, "samey.pptx"),
      slides: JSON.stringify([
        { title: "One", bullets: ["a"] }, { title: "Two", bullets: ["b"] }, { title: "Three", bullets: ["c"] },
      ]),
    });
    expect(r.content).toMatch(/Slide check found 1 problem/);
    expect(r.content).toMatch(/3 "content" slides in a row/);
    expect((r.metadata?.slide_findings as string[]).length).toBe(1);
  });
});
