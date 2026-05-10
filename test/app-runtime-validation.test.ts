import { describe, it, expect } from "vitest";
import {
  validateAppId,
  validateComponent,
  validateAppDefinition,
  meetsAccessLevel,
} from "../src/app-runtime/validation.js";
import type { ComponentDefinition } from "../src/app-runtime/types.js";

const comp = (over: Partial<ComponentDefinition> = {}): ComponentDefinition => ({
  id: "btn1",
  type: "button",
  props: {},
  ...over,
});

describe("validateAppId", () => {
  it("accepts simple alphanumeric IDs", () => {
    expect(validateAppId("myApp1")).toEqual({ valid: true, errors: [] });
  });

  it("accepts IDs with hyphens and underscores after the first char", () => {
    expect(validateAppId("my-app_1")).toEqual({ valid: true, errors: [] });
  });

  it("rejects empty ID", () => {
    const r = validateAppId("");
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/required/i);
  });

  it("rejects IDs longer than 64 chars", () => {
    const r = validateAppId("a".repeat(65));
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => /64 characters/.test(e))).toBe(true);
  });

  it("rejects IDs starting with hyphen or underscore", () => {
    expect(validateAppId("-bad").valid).toBe(false);
    expect(validateAppId("_bad").valid).toBe(false);
  });

  it("rejects IDs containing path separators or other unsafe chars", () => {
    for (const id of ["a/b", "a.b", "a b", "a$b", "a;b"]) {
      expect(validateAppId(id).valid).toBe(false);
    }
  });
});

describe("validateComponent", () => {
  it("accepts a basic button component", () => {
    expect(validateComponent(comp()).valid).toBe(true);
  });

  it("rejects an unknown component type", () => {
    const r = validateComponent(comp({ type: "evil" as any }));
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => /Invalid component type/.test(e))).toBe(true);
  });

  it("rejects a missing component ID", () => {
    const r = validateComponent(comp({ id: "" }));
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => /missing ID/i.test(e))).toBe(true);
  });

  it("rejects component IDs longer than 64 chars", () => {
    const r = validateComponent(comp({ id: "a".repeat(65) }));
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => /exceeds 64/.test(e))).toBe(true);
  });

  it("rejects unsafe characters in component ID (XSS / injection prevention)", () => {
    for (const id of ["bad<id>", `bad"id`, "bad'id", "bad&id"]) {
      const r = validateComponent(comp({ id }));
      expect(r.valid).toBe(false);
      expect(r.errors.some(e => /unsafe characters/.test(e))).toBe(true);
    }
  });

  it("rejects nesting deeper than 5 levels", () => {
    let leaf: ComponentDefinition = comp({ id: "leaf" });
    for (let i = 0; i < 7; i++) {
      leaf = comp({ id: `wrap-${i}`, children: [leaf] });
    }
    const r = validateComponent(leaf);
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => /nesting too deep/i.test(e))).toBe(true);
  });

  it("accepts up to 5 levels of nesting", () => {
    let leaf: ComponentDefinition = comp({ id: "leaf" });
    for (let i = 0; i < 4; i++) {
      leaf = comp({ id: `wrap-${i}`, children: [leaf] });
    }
    expect(validateComponent(leaf).valid).toBe(true);
  });

  it("validates children recursively (bad child fails the parent)", () => {
    const parent = comp({ id: "p", children: [comp({ type: "evil" as any })] });
    const r = validateComponent(parent);
    expect(r.valid).toBe(false);
  });
});

describe("validateAppDefinition", () => {
  it("accepts a minimal valid def", () => {
    const r = validateAppDefinition({ id: "x1", components: [comp()] });
    expect(r.valid).toBe(true);
  });

  it("rejects duplicate component IDs", () => {
    const r = validateAppDefinition({ id: "x1", components: [comp({ id: "a" }), comp({ id: "a" })] });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => /Duplicate component ID/.test(e))).toBe(true);
  });

  it("rejects > 200 components", () => {
    const components = Array.from({ length: 201 }, (_, i) => comp({ id: `c${i}` }));
    const r = validateAppDefinition({ id: "x1", components });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => /Too many components/.test(e))).toBe(true);
  });

  it("rejects names longer than 128 chars", () => {
    const r = validateAppDefinition({ id: "x1", name: "n".repeat(129) });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => /name exceeds/i.test(e))).toBe(true);
  });

  it("rejects descriptions longer than 1024 chars", () => {
    const r = validateAppDefinition({ id: "x1", description: "d".repeat(1025) });
    expect(r.valid).toBe(false);
    expect(r.errors.some(e => /description exceeds/i.test(e))).toBe(true);
  });

  it("propagates child component validation errors", () => {
    const r = validateAppDefinition({ id: "x1", components: [comp({ type: "evil" as any })] });
    expect(r.valid).toBe(false);
  });
});

describe("meetsAccessLevel", () => {
  it("admin satisfies all required levels", () => {
    expect(meetsAccessLevel("admin", "read")).toBe(true);
    expect(meetsAccessLevel("admin", "write")).toBe(true);
    expect(meetsAccessLevel("admin", "admin")).toBe(true);
  });

  it("write satisfies read but not admin", () => {
    expect(meetsAccessLevel("write", "read")).toBe(true);
    expect(meetsAccessLevel("write", "write")).toBe(true);
    expect(meetsAccessLevel("write", "admin")).toBe(false);
  });

  it("read satisfies only read", () => {
    expect(meetsAccessLevel("read", "read")).toBe(true);
    expect(meetsAccessLevel("read", "write")).toBe(false);
    expect(meetsAccessLevel("read", "admin")).toBe(false);
  });
});
