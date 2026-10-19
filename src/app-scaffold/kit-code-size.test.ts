// The structure kit's code-line counter (kit/code-size*.mjs), proven on the
// inputs a naive line counter gets wrong: comment markers inside strings,
// multi-line template literals, regexes holding `//`, docstrings, raw strings,
// Rust lifetimes. A function's own size must exclude the functions nested in
// it. The vendored copy is what every built project runs, so it is what is
// tested here.
import { describe, expect, it } from "vitest";

type Measured = { code: number; functions: Array<{ name: string; line: number; code: number }> | null; approximate: boolean };
const kit = (name: string) => new URL(`./kit/${name}`, import.meta.url).href;
const { measureSource, sizeItems } = (await import(kit("code-size.mjs"))) as {
  measureSource: (file: string, text: string, repo?: string) => Measured;
  sizeItems: (rel: string, m: Measured) => Array<{ key: string; size: number }>;
};
const { lexBraceLanguage } = (await import(kit("code-size-cfamily.mjs"))) as {
  lexBraceLanguage: (text: string, dialect: string) => { codeLines: Set<number> };
};

const measure = (file: string, lines: string[]) => measureSource(file, lines.join("\n") + "\n");
const fn = (m: Measured, name: string) => m.functions?.find((f) => f.name === name)?.code;

describe("TS/JS code lines (the compiler)", () => {
  it("counts lines with a token; comment, JSDoc and blank lines are free", () => {
    const m = measure("a.ts", [
      "/** A JSDoc block", " * spanning lines", " */",
      "// a line comment", "", "/* block", "   comment */",
      'const s = "// not a comment";',
      "const t = '/* nor this */';",
      "const r = /https?:\\/\\//;",
      "const u = `line one",
      "// inside a template, this is text",
      "${s}`;",
      "export {};",
    ]);
    expect(m.approximate).toBe(false);
    expect(m.code).toBe(7);
  });

  it("a function's own lines include its signature and exclude nested functions", () => {
    const m = measure("b.ts", [
      "export function outer(",
      "  a: number,",
      ") {",
      "  const x = a + 1;",
      "  items.forEach((item) => {",
      "    use(item);",
      "    use(item);",
      "  });",
      "  const short = (y: number) => y * 2;",
      "  return x;",
      "}",
    ]);
    // Lines 1-5 and 8-11: the callback's own lines (6, 7) are not outer's.
    expect(fn(m, "outer")).toBe(9);
    expect(fn(m, "items.forEach:callback")).toBe(4);
    expect(m.functions?.map((f) => f.name)).not.toContain("short");
  });

  it("names methods, object members, returned functions, and disambiguates duplicates by line", () => {
    const m = measure("c.ts", [
      "class Store { save() { return 1; } get size() { return 0; } constructor() {} }",
      'export const tool = { name: "memory_save", execute() { return 2; } };',
      'const unnamed = [{ name: "remember", execute() { return 3; } }];',
      "export function makeRunner() { return async (input: string) => { return input; }; }",
      "app.on('a', () => { one(); });",
      "app.on('b', () => { two(); });",
    ]);
    const names = m.functions!.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining([
      "Store.save", "Store.size", "Store.constructor", "tool.execute", "remember.execute", "makeRunner", "makeRunner:returned",
    ]));
    const keys = sizeItems("src/c.ts", m).map((it) => it.key);
    expect(keys).toEqual(expect.arrayContaining(["src/c.ts", "src/c.ts#Store.save", "src/c.ts#app.on:callback@5", "src/c.ts#app.on:callback@6"]));
  });

  it("without the compiler the lexer still keeps strings, templates and regexes apart from comments", () => {
    const { codeLines } = lexBraceLanguage([
      "// comment",
      'const a = "// x"; /* c */',
      "const t = `a ${ { k: '}' }.k } // still template",
      "/* text */ `",
      "const r = x / 2 / y; // division, then a comment",
      "const re = /[/]\\//g;",
      "/* only a comment */",
    ].join("\n"), "js");
    expect([...codeLines]).toEqual([2, 3, 4, 5, 6]);
  });
});

describe("Python code lines and functions", () => {
  it("docstrings and comments are free; a # inside a string is code", () => {
    const m = measure("a.py", [
      '"""Module docstring.',
      "",
      'More."""',
      "# comment",
      "import os",
      "",
      "class Store:",
      '    """Class docstring."""',
      "",
      "    def save(self, x):",
      "        '''Method docstring'''",
      '        text = "# not a comment"',
      "        query = '''",
      "        SELECT 1  # part of the string",
      "        '''",
      "        return text",
    ]);
    expect(m.code).toBe(8);
    expect(fn(m, "Store.save")).toBe(6);
  });

  it("a def's own lines exclude the defs nested in it", () => {
    const m = measure("b.py", [
      "@decorated",
      "async def outer(a,",
      "                b):",
      "    x = a",
      "    def inner():",
      "        return 1",
      "        # trailing comment",
      "    return inner() + x",
      "def after():",
      "    pass",
    ]);
    expect(fn(m, "outer")).toBe(5);
    expect(fn(m, "outer.inner")).toBe(2);
    expect(fn(m, "after")).toBe(2);
  });
});

describe("Go code lines and functions", () => {
  it("raw strings, runes and comments; func literals count for themselves", () => {
    const m = measure("a.go", [
      "package main",
      "// comment { not a brace",
      "func (s *Server[T]) Handle(cb func(int) error) interface{} {",
      "\tq := `raw // not a comment",
      "{ not a brace }`",
      "\tr := '{'",
      "\tgo func() {",
      "\t\tuse(q, r)",
      "\t}()",
      "\t/* block */",
      "\treturn nil",
      "}",
    ]);
    expect(m.code).toBe(10);
    // Line 8 is the literal's alone; 7 (`go `) and 9 (`()`) are shared.
    expect(fn(m, "Server.Handle")).toBe(8);
    expect(fn(m, "Server.Handle.func1")).toBe(3);
    expect(m.functions).toHaveLength(2);
  });
});

describe("Rust code lines and functions", () => {
  it("raw strings, chars vs lifetimes, nested block comments; impl methods are Type::name", () => {
    const m = measure("a.rs", [
      "/* outer /* nested */ still comment */",
      "struct Wrapper<'a> { s: &'a str }",
      "impl<'a> Display for Wrapper<'a> {",
      "    fn fmt(&self, f: &mut Formatter<'_>) -> Result {",
      '        let raw = r#"a "quoted" // not a comment { "#;',
      "        let c = '{';",
      "        fn helper() -> impl Iterator<Item = u8> {",
      "            std::iter::empty()",
      "        }",
      "        write!(f, \"{}\", raw)",
      "    }",
      "}",
      "trait Named { fn name(&self) -> String; }",
      "type Callback = fn(i32) -> i32;",
    ]);
    expect(m.code).toBe(13);
    expect(fn(m, "Wrapper::fmt")).toBe(5);
    expect(fn(m, "helper")).toBe(3);
    expect(m.functions?.map((f) => f.name).sort()).toEqual(["Wrapper::fmt", "helper"]);
  });
});
