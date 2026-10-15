// The op-type registry (op-types.ts) is the only place harness op types are spelled.
// A literal compared with an op type compiles even when it names no real type: the
// app design guard skipped "build_app" while builds are "app_build", and its test
// passed the same wrong value, so both agreed and every build was told to redo its
// UI. This scan fails on the shapes that bug took, anywhere in src/.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DELEGATED_OP_LABEL, OP_TYPE } from "./op-types.js";

const SRC = join(process.cwd(), "src");
const SELF = join(SRC, "ops", "op-types.ts");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "node_modules" || name === "vendor" ? [] : sources(p);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) && p !== SELF ? [p] : [];
  });
}

/** Code with comments blanked (line numbers kept), so prose about op types is free. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

/** An op-type expression: `op.type`, `ctx.op.type`, `parentOp?.type`, `opType`, `e.opType`. */
const OP_TYPE_EXPR = String.raw`(?:\b\w*[oO]p\??\.type\b|\bopType\b|\.opType\b)`;
const RULES: Array<{ name: string; re: RegExp }> = [
  { name: "compared with a string literal", re: new RegExp(String.raw`(?<!typeof\s+[\w.?]*)${OP_TYPE_EXPR}\s*[!=]==?\s*["'\`]`) },
  { name: "string literal compared with it", re: new RegExp(String.raw`["'\`]\s*[!=]==?\s*${OP_TYPE_EXPR}`) },
  { name: "prefix-matched against a string literal", re: new RegExp(String.raw`${OP_TYPE_EXPR}\??\.startsWith\(\s*["'\`]`) },
];
/** A set of op types whose first member is a literal; matched across lines. */
const SPELLED_SET = /\b\w*OP_TYPES\b[^=;]*=\s*new Set(?:<[^>]*>)?\(\[\s*["'`]/g;

describe("op types are never spelled outside op-types.ts", () => {
  it("no op type is compared, prefix-matched or collected as a raw literal", () => {
    const hits: string[] = [];
    for (const file of sources(SRC)) {
      const text = code(readFileSync(file, "utf8"));
      const where = relative(process.cwd(), file);
      text.split("\n").forEach((line, i) => {
        for (const rule of RULES) {
          if (rule.re.test(line)) hits.push(`${where}:${i + 1} (${rule.name}): ${line.trim()}`);
        }
      });
      for (const m of text.matchAll(SPELLED_SET)) {
        hits.push(`${where}:${text.slice(0, m.index).split("\n").length} (a set of op types spelled out): ${m[0].trim()}`);
      }
    }
    expect(hits, "use OP_TYPE / DELEGATED_OP_LABEL from src/ops/op-types.ts").toEqual([]);
  });

  it("each name is spelled once, and harness types never collide with a delegated label", () => {
    const harness = Object.values(OP_TYPE);
    expect(new Set(harness).size).toBe(harness.length);
    for (const label of Object.values(DELEGATED_OP_LABEL)) expect(harness).not.toContain(label);
  });
});

describe("the scan itself", () => {
  const caught = (line: string) => RULES.some((r) => r.re.test(line)) || new RegExp(SPELLED_SET.source).test(line);
  it("catches the shapes the bug took", () => {
    expect(caught(`if (ctx.op.type === "build_app") return;`)).toBe(true);
    expect(caught(`return opType === "chat_turn" || opType === "agent_spawn";`)).toBe(true);
    expect(caught(`&& !op.type.startsWith("app_build")`)).toBe(true);
    expect(caught(`const HIDDEN_OP_TYPES: ReadonlySet<string> = new Set([\n  "chat_turn",\n]);`)).toBe(true);
    expect(caught(`const MAINTENANCE_OP_TYPES = new Set(["skill_review"]);`)).toBe(true);
    expect(caught(`const surface = e.opType === "chat_turn" ? "" : x;`)).toBe(true);
  });
  it("leaves the legitimate shapes alone", () => {
    expect(caught(`if (typeof op.type !== "string") return false;`)).toBe(false);
    expect(caught(`return typeof value.opType === "string" && ok;`)).toBe(false);
    expect(caught(`if (op.type === OP_TYPE.appBuild) return;`)).toBe(false);
    expect(caught(`if (tc.name === "build_app") return;`)).toBe(false);
    expect(caught(`if (event.type === "done") return;`)).toBe(false);
  });
});
