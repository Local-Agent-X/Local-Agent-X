/**
 * A sent document as a readable page (`?view=html`): what the phone shows when
 * no installed app opens the file (2026-11-08, a Word cheat sheet on a phone
 * with no Word). The page must be the document's text, inert, and never the
 * raw bytes.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Document, Packer, Paragraph, TextRun } from "docx";
import ExcelJSDefault from "exceljs";
import { DOCUMENT_VIEW_CSP, documentViewHtml } from "./document-view.js";
import { serveProtectedAssets } from "./static-assets.js";
import type { LAXConfig } from "../types.js";

const ExcelJS = (ExcelJSDefault as unknown as { default: typeof ExcelJSDefault }).default ?? ExcelJSDefault;

async function wordFile(lines: string[]): Promise<Buffer> {
  const doc = new Document({ sections: [{ children: lines.map((l) => new Paragraph({ children: [new TextRun(l)] })) }] });
  return Buffer.from(await Packer.toBuffer(doc));
}

describe("documentViewHtml", () => {
  it("a Word file becomes its text, with anything markup-shaped in it escaped", async () => {
    const html = await documentViewHtml("cheat-sheet.docx", await wordFile(["Q1. Why this role?", "<script>alert(1)</script>"]));
    expect(html).toContain("Q1. Why this role?");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("<title>cheat-sheet.docx</title>");
  });

  it("a workbook becomes one table per sheet", async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet("Budget");
    sheet.addRow(["Item", "Cost"]);
    sheet.addRow(["Rent <main>", 1200]);
    const html = await documentViewHtml("budget.xlsx", Buffer.from(await wb.xlsx.writeBuffer()));
    expect(html).toContain("<h2>Budget</h2>");
    expect(html).toContain("<th>Item</th><th>Cost</th>");
    expect(html).toContain("<td>Rent &lt;main&gt;</td><td>1200</td>");
  });

  it("a CSV becomes a table and plain text stays text", async () => {
    expect(await documentViewHtml("list.csv", Buffer.from("name,qty\napples,3\n"))).toContain("<td>apples</td><td>3</td>");
    expect(await documentViewHtml("notes.md", Buffer.from("# Notes & <b>things</b>"))).toContain("<pre># Notes &amp; &lt;b&gt;things&lt;/b&gt;</pre>");
  });

  it("a legacy binary format has no view", async () => {
    expect(await documentViewHtml("old.doc", Buffer.from("x"))).toBeNull();
  });
});

describe("GET /uploads/<file>?view=html", () => {
  const dir = mkdtempSync(join(tmpdir(), "lax-doc-view-"));
  mkdirSync(join(dir, "uploads"));
  const TOKEN = "operator-token-for-test-0123456789abcdef";
  const config = { authToken: TOKEN, workspace: dir } as LAXConfig;

  function get(path: string): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    return new Promise((done) => {
      const out = { status: 0, headers: {} as Record<string, string>, body: "" };
      const res = {
        writeHead(status: number, headers?: Record<string, string>) { out.status = status; out.headers = headers ?? {}; return res; },
        setHeader() {},
        end(body?: unknown) { out.body = body === undefined ? "" : String(body); done(out); },
      } as unknown as ServerResponse;
      const req = { headers: { authorization: `Bearer ${TOKEN}` } } as unknown as IncomingMessage;
      serveProtectedAssets("GET", new URL(path, "http://127.0.0.1:7007"), req, res, config, dir);
    });
  }

  it("answers with the readable page, served inert", async () => {
    writeFileSync(join(dir, "uploads", "fccfc3fa-cheat-sheet.docx"), await wordFile(["Read it out loud once a day."]));
    const r = await get("/uploads/fccfc3fa-cheat-sheet.docx?view=html");
    expect(r.status).toBe(200);
    expect(r.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(r.headers["Content-Security-Policy"]).toBe(DOCUMENT_VIEW_CSP);
    expect(r.body).toContain("Read it out loud once a day.");
  });

  it("without the view, the file's own bytes as before; an unconvertible type is 415", async () => {
    writeFileSync(join(dir, "uploads", "old.doc"), "legacy");
    expect((await get("/uploads/old.doc")).body).toBe("legacy");
    expect((await get("/uploads/old.doc?view=html")).status).toBe(415);
  });
});
