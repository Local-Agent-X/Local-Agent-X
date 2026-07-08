import { describe, it, expect } from "vitest";
import { stripCodeFences } from "./strip-code-fences.js";

describe("stripCodeFences", () => {
  it("returns unfenced input trimmed", () => {
    expect(stripCodeFences('  {"a": 1}  ')).toBe('{"a": 1}');
  });

  it("unwraps a ```json fence", () => {
    expect(stripCodeFences('```json\n{"a": 1}\n```')).toBe('{"a": 1}');
  });

  it("unwraps a bare ``` fence (no language tag)", () => {
    expect(stripCodeFences('```\n{"a": 1}\n```')).toBe('{"a": 1}');
  });

  it("extracts the fenced block when surrounded by prose", () => {
    expect(stripCodeFences('Here you go:\n```json\n{"a": 1}\n```\nDone.')).toBe('{"a": 1}');
  });

  it("keeps backticks inside the payload intact", () => {
    const inner = '{"content": "use `npm run build` not `tsc`"}';
    expect(stripCodeFences("```json\n" + inner + "\n```")).toBe(inner);
  });

  it("strips an unterminated opening fence (truncated reply)", () => {
    expect(stripCodeFences('```json\n{"a": 1}')).toBe('{"a": 1}');
  });

  it("handles CRLF line endings around the fence", () => {
    expect(stripCodeFences('```json\r\n{"a": 1}\r\n```')).toBe('{"a": 1}');
  });

  it("returns the first block when multiple fenced blocks exist", () => {
    expect(stripCodeFences("```json\n{\"a\": 1}\n```\ntext\n```json\n{\"b\": 2}\n```")).toBe('{"a": 1}');
  });

  it("passes plain prose through untouched", () => {
    expect(stripCodeFences("no fences here")).toBe("no fences here");
  });
});
