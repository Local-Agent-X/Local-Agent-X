/**
 * When the user's message names a saved brand, the Office files made for it
 * are made in that brand by code: the model is not trusted to remember. It
 * fills only what the model left out, and reads only a message a person
 * typed.
 */
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { brandMatchMiddleware } from "./brand-match.js";
import { officeThemeGuardMiddleware } from "./office-theme-guard.js";
import { makeCanonicalLoopContext } from "./ctx.test-helper.js";
import type { ToolCall } from "../contract-types.js";
import { brandNamedIn, brandsDir, listBrands, saveBrand } from "../../tools/shared/brand-store.js";

beforeEach(() => {
  rmSync(brandsDir(), { recursive: true, force: true });
  saveBrand({ name: "NutriShop", aliases: ["the store"] });
  saveBrand({ name: "PMAJ Labs" });
});

const run = (message: string, toolCalls: ToolCall[], extra: Record<string, unknown> = {}) =>
  brandMatchMiddleware.afterModelCall!(makeCanonicalLoopContext({ op: { id: "op-bm", ...extra }, currentUserMessage: message, toolCalls }));

describe("brand-match", () => {
  it("fills the brand the message names into an Office call (string args)", () => {
    const tc = { toolCallId: "t1", tool: "presentation", args: JSON.stringify({ action: "create", file_path: "a.pptx", slides: "[]" }) };
    run("make a nutrishop deck for the protein sale", [tc]);
    expect(JSON.parse(tc.args as string).brand).toBe("NutriShop");
  });

  it("matches an alias and a multi-word name, and fills charts too", () => {
    const doc = { toolCallId: "t1", tool: "document", args: { action: "create", file_path: "a.docx", content: "x" } };
    run("write the store's price list", [doc]);
    expect(doc.args).toHaveProperty("brand", "NutriShop");
    const chart = { toolCallId: "t2", tool: "create_chart", args: { file_path: "c.png", type: "bar", series: "[]" } };
    run("chart PMAJ Labs revenue", [chart]);
    expect(chart.args).toHaveProperty("brand", "PMAJ Labs");
  });

  it("never overrides a brand the model chose, \"none\" included", () => {
    const tc = { toolCallId: "t1", tool: "pdf", args: { action: "create", file_path: "a.pdf", content: "x", brand: "none" } };
    run("a NutriShop flyer but plain", [tc]);
    expect(tc.args.brand).toBe("none");
  });

  it("leaves other tools, unnamed brands and part-word matches alone", () => {
    const write = { toolCallId: "t1", tool: "write", args: { path: "a.txt", content: "x" } };
    const doc = { toolCallId: "t2", tool: "document", args: { action: "create", file_path: "a.docx", content: "x" } };
    run("nutrishop notes", [write]);
    run("write a report on nutrishopping trends", [doc]);
    expect(write.args).not.toHaveProperty("brand");
    expect(doc.args).not.toHaveProperty("brand");
  });

  it("does not read a harness-composed task as the user naming a brand", () => {
    const tc = { toolCallId: "t1", tool: "document", args: { action: "create", file_path: "a.docx", content: "x" } };
    run("build the NutriShop site docs", [tc], { taskProvenance: "harness" });
    expect(tc.args).not.toHaveProperty("brand");
  });

  it("picks the brand named first when a message names two", () => {
    expect(brandNamedIn("a PMAJ Labs deck for NutriShop", listBrands())?.name).toBe("PMAJ Labs");
  });

  it("the theme guard strips an uninvited theme but keeps the brand", () => {
    const tc = { toolCallId: "t1", tool: "presentation", args: { action: "create", file_path: "a.pptx", slides: "[]", brand: "NutriShop", theme: "{}" } };
    officeThemeGuardMiddleware.afterModelCall!(makeCanonicalLoopContext({ op: { id: "op-bm" }, currentUserMessage: "deck about shakes", toolCalls: [tc] }));
    expect(tc.args).not.toHaveProperty("theme");
    expect(tc.args).toHaveProperty("brand", "NutriShop");
  });
});
