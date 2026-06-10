/**
 * Markdown block AST → docx elements. Renders styled inline runs, real tables,
 * bullet/ordered/nested lists, blockquotes, code blocks, and rules — all
 * themed. Text is already sanitized by office-md (no HTML/entities leak).
 */
import * as docx from "docx";
import { half, type OfficeTheme } from "./office-theme.js";
import { parseMarkdown, type Block, type Span } from "./office-md.js";

const { Paragraph, TextRun, ExternalHyperlink, Table, TableRow, TableCell, WidthType, BorderStyle, HeadingLevel } = docx;

const MONO = "Courier New"; // universal base-font for code

type Run = docx.TextRun | docx.ExternalHyperlink;

function runsFor(spans: Span[], t: OfficeTheme, force?: { color?: string; bold?: boolean }): Run[] {
  const runs = spans.map((s): Run => {
    if (s.href) {
      return new ExternalHyperlink({
        link: s.href,
        children: [new TextRun({ text: s.text, color: t.colors.accent, underline: {} })],
      });
    }
    return new TextRun({
      text: s.text,
      bold: force?.bold ?? s.bold,
      italics: s.italic,
      strike: s.strike,
      ...(force?.color ? { color: force.color } : s.code ? { color: t.colors.subheading } : {}),
      ...(s.code ? { font: MONO } : {}),
    });
  });
  return runs.length ? runs : [new TextRun("")];
}

const HEADING = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 } as const;

function buildTable(block: Extract<Block, { kind: "table" }>, t: OfficeTheme): docx.Table {
  const edge = { style: BorderStyle.SINGLE, size: 4, color: t.colors.border };
  const borders = { top: edge, bottom: edge, left: edge, right: edge };
  const margins = { top: 40, bottom: 40, left: 80, right: 80 };

  const headerRow = new TableRow({
    tableHeader: true,
    children: block.header.map((cell) => new TableCell({
      shading: { fill: t.colors.accent },
      margins,
      children: [new Paragraph({ children: runsFor(cell, t, { color: t.colors.accentText, bold: true }) })],
    })),
  });

  const bodyRows = block.rows.map((row, r) => new TableRow({
    children: row.map((cell) => new TableCell({
      ...(r % 2 === 1 ? { shading: { fill: t.colors.band } } : {}),
      margins,
      children: [new Paragraph({ children: runsFor(cell, t) })],
    })),
  }));

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders,
    rows: [headerRow, ...bodyRows],
  });
}

function blockToParagraphs(block: Block, t: OfficeTheme, ordinal: number): docx.Paragraph[] {
  switch (block.kind) {
    case "heading":
      return [new Paragraph({ heading: HEADING[block.level], children: runsFor(block.spans, t) })];
    case "para":
      return [new Paragraph({ children: runsFor(block.spans, t) })];
    case "bullet":
      return [new Paragraph({ bullet: { level: Math.min(block.level, 4) }, children: runsFor(block.spans, t) })];
    case "ordered":
      return [new Paragraph({
        indent: { left: 360 + Math.min(block.level, 4) * 360 },
        children: [new TextRun({ text: `${ordinal}. `, bold: true }), ...runsFor(block.spans, t)],
      })];
    case "quote":
      return [new Paragraph({
        indent: { left: 360 },
        border: { left: { style: BorderStyle.SINGLE, size: 18, color: t.colors.accent, space: 12 } },
        children: runsFor(block.spans, t).map((r) => r),
        spacing: { before: 40, after: 40 },
      })];
    case "code":
      return block.text.split("\n").map((ln) => new Paragraph({
        shading: { fill: "F4F5F7" },
        spacing: { after: 0 },
        children: [new TextRun({ text: ln || " ", font: MONO, size: half(t.doc.bodySize - 0.5), color: t.colors.subheading })],
      }));
    case "hr":
      return [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: t.colors.border, space: 1 } }, children: [] })];
    case "blank":
      return [new Paragraph({ children: [] })];
    default:
      return [];
  }
}

/** Render a markdown source string into docx body elements (paragraphs + tables). */
export function markdownToDocx(src: string, theme: OfficeTheme): (docx.Paragraph | docx.Table)[] {
  const blocks = parseMarkdown(src);
  const out: (docx.Paragraph | docx.Table)[] = [];
  let ordinal = 0; // running count for consecutive ordered-list items
  for (const block of blocks) {
    if (block.kind === "ordered") ordinal += 1; else ordinal = 0;
    if (block.kind === "table") out.push(buildTable(block, theme));
    else out.push(...blockToParagraphs(block, theme, ordinal));
  }
  return out;
}
