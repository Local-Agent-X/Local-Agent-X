import { describe, it, expect } from "vitest";
import {
  repairJson,
  coerceArgs,
  type JsonRepairResult,
  type JsonRepairFailure,
} from "../src/tool-execution/arg-repair.js";

// Progressive-relaxation recovery for tool-call argument blobs emitted by
// weaker models. Two pure functions:
//   repairJson  — tolerate common JSON malformations, returning a tagged
//                 {ok:true,value,fixes} or {ok:false,fixes} result.
//   coerceArgs  — coerce a parsed value's type to match the tool's JSON schema.
// These tests pin both the happy path (well-formed input is untouched) and the
// documented recovery behaviors, plus the documented failure shape.

// Narrowing helper so assertions read cleanly.
function ok(r: JsonRepairResult | JsonRepairFailure): JsonRepairResult {
  expect(r.ok).toBe(true);
  return r as JsonRepairResult;
}

describe("repairJson — fast path (already well-formed)", () => {
  it("parses clean JSON object and applies NO fixes", () => {
    const r = ok(repairJson('{"a": 1, "b": "x"}'));
    expect(r.value).toEqual({ a: 1, b: "x" });
    expect(r.fixes).toEqual([]);
  });

  it("tolerates surrounding whitespace without recording a fix", () => {
    const r = ok(repairJson('   \n {"k": true} \t '));
    expect(r.value).toEqual({ k: true });
    expect(r.fixes).toEqual([]);
  });

  it("returns failure (empty fixes) for empty / whitespace-only input", () => {
    expect(repairJson("")).toEqual({ ok: false, fixes: [] });
    expect(repairJson("   \n\t  ")).toEqual({ ok: false, fixes: [] });
  });

  // A top-level JSON array is valid JSON but is NOT an object, so the fast
  // path declines it; it falls through and ultimately fails.
  it("rejects a top-level array (must be an object)", () => {
    const r = repairJson("[1, 2, 3]");
    expect(r.ok).toBe(false);
  });
});

describe("repairJson — trailing commas", () => {
  it("removes a trailing comma before a closing brace", () => {
    const r = ok(repairJson('{"a": 1, "b": 2,}'));
    expect(r.value).toEqual({ a: 1, b: 2 });
    expect(r.fixes).toContain("removed-trailing-comma");
  });

  it("removes a trailing comma inside a nested array/object", () => {
    const r = ok(repairJson('{"list": [1, 2, 3,], "o": {"x": 1,},}'));
    expect(r.value).toEqual({ list: [1, 2, 3], o: { x: 1 } });
    expect(r.fixes).toContain("removed-trailing-comma");
  });
});

describe("repairJson — single-quoted strings and keys", () => {
  it("converts single-quoted values to double-quoted", () => {
    const r = ok(repairJson(`{"a": 'hello'}`));
    expect(r.value).toEqual({ a: "hello" });
    expect(r.fixes).toContain("single-to-double-quotes");
  });

  it("converts single-quoted keys AND values together", () => {
    const r = ok(repairJson(`{'name': 'Ada', 'n': 2}`));
    expect(r.value).toEqual({ name: "Ada", n: 2 });
    expect(r.fixes).toContain("single-to-double-quotes");
  });

  it("preserves an apostrophe inside a double-quoted string", () => {
    const r = ok(repairJson(`{"msg": "it's fine", "x": 'y'}`));
    expect(r.value).toEqual({ msg: "it's fine", x: "y" });
  });
});

describe("repairJson — unquoted (bare identifier) keys", () => {
  it("quotes bare keys", () => {
    const r = ok(repairJson('{foo: 1, bar_baz: "x"}'));
    expect(r.value).toEqual({ foo: 1, bar_baz: "x" });
    expect(r.fixes).toContain("quoted-bare-keys");
  });

  it("quotes bare keys combined with single-quoted values", () => {
    const r = ok(repairJson(`{path: '/tmp/x', count: 3}`));
    expect(r.value).toEqual({ path: "/tmp/x", count: 3 });
    expect(r.fixes).toContain("quoted-bare-keys");
  });
});

describe("repairJson — fenced ```json blocks", () => {
  it("strips a ```json fence", () => {
    const raw = '```json\n{"a": 1}\n```';
    const r = ok(repairJson(raw));
    expect(r.value).toEqual({ a: 1 });
    expect(r.fixes).toContain("stripped-code-fence");
  });

  it("strips a bare ``` fence (no language tag)", () => {
    const raw = '```\n{"ok": true}\n```';
    const r = ok(repairJson(raw));
    expect(r.value).toEqual({ ok: true });
    expect(r.fixes).toContain("stripped-code-fence");
  });

  it("trims prose before/after the object to the brace span", () => {
    const raw = 'Sure! Here are the args: {"a": 1} hope that helps';
    const r = ok(repairJson(raw));
    expect(r.value).toEqual({ a: 1 });
    expect(r.fixes).toContain("trimmed-to-braces");
  });
});

describe("repairJson — Python-ish literals", () => {
  it("normalizes True/False/None to JSON literals", () => {
    const r = ok(repairJson('{"a": True, "b": False, "c": None}'));
    expect(r.value).toEqual({ a: true, b: false, c: null });
    expect(r.fixes).toContain("normalized-py-literals");
  });
});

describe("repairJson — combined malformations", () => {
  it("repairs fence + bare keys + single quotes + trailing comma together", () => {
    const raw = "```json\n{cmd: 'ls -la', flag: True,}\n```";
    const r = ok(repairJson(raw));
    expect(r.value).toEqual({ cmd: "ls -la", flag: true });
    // The fix list records each layer that fired.
    expect(r.fixes).toEqual(
      expect.arrayContaining([
        "stripped-code-fence",
        "removed-trailing-comma",
        "single-to-double-quotes",
        "quoted-bare-keys",
        "normalized-py-literals",
      ]),
    );
  });
});

describe("repairJson — malformed beyond repair returns the documented failure shape", () => {
  it("truncated JSON (missing closing brace) fails with ok:false", () => {
    // Brace span trimming cannot balance an unterminated object, and no later
    // layer inserts a closing brace, so this is irrecoverable.
    const r = repairJson('{"a": 1, "b": ');
    expect(r.ok).toBe(false);
    expect(Array.isArray((r as JsonRepairFailure).fixes)).toBe(true);
  });

  it("a bare non-JSON sentence fails (no object present)", () => {
    const r = repairJson("totally not json at all");
    expect(r).toEqual({ ok: false, fixes: [] });
  });

  it("failure result never carries a `value` field", () => {
    const r = repairJson('{"a": 1, "b": ');
    expect(r.ok).toBe(false);
    expect("value" in r).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// coerceArgs
// ---------------------------------------------------------------------------

describe("coerceArgs — no schema / no properties is a pass-through", () => {
  it("returns args unchanged with no schema", () => {
    const args = { a: "1" };
    const r = coerceArgs(args, undefined);
    expect(r.coerced).toBe(args); // same reference, untouched
    expect(r.fixes).toEqual([]);
  });

  it("returns args unchanged when schema has no properties", () => {
    const args = { a: "1" };
    const r = coerceArgs(args, { type: "object" });
    expect(r.coerced).toBe(args);
    expect(r.fixes).toEqual([]);
  });
});

describe("coerceArgs — string → number / integer", () => {
  const schema = {
    properties: { n: { type: "number" }, i: { type: "integer" } },
  };

  it('coerces "5" → 5 for a number field and "3.5" → 3.5', () => {
    const r = coerceArgs({ n: "3.5" }, schema);
    expect(r.coerced.n).toBe(3.5);
    expect(typeof r.coerced.n).toBe("number");
    expect(r.fixes).toContain("n:string→number");
  });

  it('coerces "10" → 10 for an integer field', () => {
    const r = coerceArgs({ i: "10" }, schema);
    expect(r.coerced.i).toBe(10);
    expect(r.fixes).toContain("i:string→integer");
  });

  it("coerces negative numeric strings", () => {
    const r = coerceArgs({ n: "-2.5", i: "-7" }, schema);
    expect(r.coerced.n).toBe(-2.5);
    expect(r.coerced.i).toBe(-7);
  });

  it("does NOT coerce a non-numeric string for a number field", () => {
    const r = coerceArgs({ n: "abc" }, schema);
    expect(r.coerced.n).toBe("abc");
    expect(r.fixes).toEqual([]);
  });

  it("does NOT coerce a float string for an integer field", () => {
    const r = coerceArgs({ i: "3.5" }, schema);
    expect(r.coerced.i).toBe("3.5");
    expect(r.fixes).toEqual([]);
  });

  it("leaves an already-numeric value untouched (no coercion needed)", () => {
    const r = coerceArgs({ n: 4 }, schema);
    expect(r.coerced.n).toBe(4);
    expect(r.fixes).toEqual([]);
  });
});

describe("coerceArgs — boolean coercion", () => {
  const schema = { properties: { b: { type: "boolean" } } };

  it('coerces "true"/"false" (case-insensitive, trimmed) → bool', () => {
    expect(coerceArgs({ b: "true" }, schema).coerced.b).toBe(true);
    expect(coerceArgs({ b: "FALSE" }, schema).coerced.b).toBe(false);
    expect(coerceArgs({ b: "  True  " }, schema).coerced.b).toBe(true);
    expect(coerceArgs({ b: "true" }, schema).fixes).toContain("b:string→bool");
  });

  it("coerces numeric 0/1 → bool", () => {
    expect(coerceArgs({ b: 1 }, schema).coerced.b).toBe(true);
    expect(coerceArgs({ b: 0 }, schema).coerced.b).toBe(false);
    expect(coerceArgs({ b: 1 }, schema).fixes).toContain("b:number→bool");
  });

  it("does NOT coerce a non-boolean string like 'yes'", () => {
    const r = coerceArgs({ b: "yes" }, schema);
    expect(r.coerced.b).toBe("yes");
    expect(r.fixes).toEqual([]);
  });

  it("does NOT coerce a number other than 0/1", () => {
    const r = coerceArgs({ b: 2 }, schema);
    expect(r.coerced.b).toBe(2);
    expect(r.fixes).toEqual([]);
  });
});

describe("coerceArgs — number/boolean → string", () => {
  const schema = { properties: { s: { type: "string" } } };

  it("coerces a number to its string form", () => {
    const r = coerceArgs({ s: 42 }, schema);
    expect(r.coerced.s).toBe("42");
    expect(r.fixes).toContain("s:number→string");
  });

  it("coerces a boolean to 'true'/'false'", () => {
    expect(coerceArgs({ s: true }, schema).coerced.s).toBe("true");
    expect(coerceArgs({ s: false }, schema).coerced.s).toBe("false");
    expect(coerceArgs({ s: true }, schema).fixes).toContain("s:bool→string");
  });
});

describe("coerceArgs — string → array", () => {
  const schema = { properties: { items: { type: "array" } } };

  it("parses a JSON-array string into a real array", () => {
    const r = coerceArgs({ items: "[1, 2, 3]" }, schema);
    expect(r.coerced.items).toEqual([1, 2, 3]);
    expect(r.fixes).toContain("items:string→array");
  });

  it("wraps a bare scalar string into a single-element array", () => {
    const r = coerceArgs({ items: "lonely" }, schema);
    expect(r.coerced.items).toEqual(["lonely"]);
    expect(r.fixes).toContain("items:string→array[1]");
  });

  // A "[...]"-looking string whose contents are not valid JSON falls back to
  // the single-element wrap rather than throwing. Pin that documented behavior.
  it("wraps an unparseable bracket-string as a single-element array", () => {
    const r = coerceArgs({ items: "[not, valid]" }, schema);
    expect(r.coerced.items).toEqual(["[not, valid]"]);
    expect(r.fixes).toContain("items:string→array[1]");
  });
});

describe("coerceArgs — scope and immutability", () => {
  it("ignores keys not present in args (no spurious fixes)", () => {
    const schema = { properties: { a: { type: "number" }, b: { type: "number" } } };
    const r = coerceArgs({ a: "1" }, schema);
    expect(r.coerced).toEqual({ a: 1 });
    expect("b" in r.coerced).toBe(false);
    expect(r.fixes).toEqual(["a:string→number"]);
  });

  it("ignores properties with no declared type", () => {
    const schema = { properties: { a: {} } };
    const r = coerceArgs({ a: "1" }, schema);
    expect(r.coerced.a).toBe("1");
    expect(r.fixes).toEqual([]);
  });

  it("does not mutate the input args object (returns a copy)", () => {
    const schema = { properties: { a: { type: "number" } } };
    const args = { a: "1" };
    const r = coerceArgs(args, schema);
    expect(args.a).toBe("1"); // original untouched
    expect(r.coerced).not.toBe(args);
    expect(r.coerced.a).toBe(1);
  });
});

describe("repairJson + coerceArgs — end-to-end recovery", () => {
  it("repairs a malformed blob then coerces by schema", () => {
    const raw = "```json\n{count: '5', enabled: 'true', tags: '[\"a\",\"b\"]',}\n```";
    const repaired = ok(repairJson(raw));
    const schema = {
      properties: {
        count: { type: "integer" },
        enabled: { type: "boolean" },
        tags: { type: "array" },
      },
    };
    const { coerced } = coerceArgs(repaired.value, schema);
    expect(coerced).toEqual({ count: 5, enabled: true, tags: ["a", "b"] });
  });
});
