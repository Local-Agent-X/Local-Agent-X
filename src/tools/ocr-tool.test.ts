// OCR runs on this computer from the engine and English data installed with
// LAX: no CLI to install, nothing fetched at run time. A language that is not
// installed is refused instead of downloaded.
import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { recognizeText, stopOcr } from "./ocr-tool.js";

const invoice = readFileSync(fileURLToPath(new URL("../../test/fixtures/ocr-invoice.png", import.meta.url)));

afterAll(() => stopOcr());

describe("recognizeText", () => {
  it("reads the words in an image", async () => {
    const result = await recognizeText(invoice);
    expect(result.text).toMatch(/Invoice 4471 is due in March/i);
    expect(result.language).toBe("eng");
  }, 60_000);

  it("reuses one engine for jobs that arrive together", async () => {
    const [a, b] = await Promise.all([recognizeText(invoice), recognizeText(invoice)]);
    expect(a.text).toBe(b.text);
  }, 60_000);

  it("refuses a language that is not installed", async () => {
    await expect(recognizeText(invoice, "fra")).rejects.toThrow(/not installed/);
  });
});
