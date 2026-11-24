// What a plugin may declare as a tool's parameters: a closed subset of JSON
// schema. Each rejection names the offending path.
import { describe, expect, it } from "vitest";
import { validateToolParameterSchema } from "./tool-schema.js";

const withProp = (prop: Record<string, unknown>): Record<string, unknown> =>
  ({ type: "object", properties: { x: prop } });
const rejects = (schema: unknown, message: string): void => {
  expect(() => validateToolParameterSchema(schema)).toThrow(message);
};

describe("validateToolParameterSchema", () => {
  it("accepts an object schema that uses every supported bound", () => {
    expect(() => validateToolParameterSchema({
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 40, pattern: "^[a-z]+$" },
        count: { type: "integer", minimum: 0, maximum: 10, default: 3 },
        tags: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 5 },
        mode: { type: "string", enum: ["a", "b"] },
      },
      required: ["name"],
      additionalProperties: false,
    })).not.toThrow();
  });

  it("requires an object schema with properties at the root", () => {
    rejects({ type: "string" }, "parameters.type must be object");
    rejects({ type: "object" }, "parameters.properties must be an object");
    rejects("nope", "parameters must be a plain object schema");
  });

  it("rejects a keyword outside the supported set, and an unknown type", () => {
    rejects(withProp({ type: "string", $ref: "#/x" }), "parameters.properties.x.$ref is not a supported tool-schema keyword");
    rejects(withProp({ type: "date" }), "parameters.properties.x.type must be a supported JSON-schema type");
  });

  it("rejects a bound that is not a sane number", () => {
    rejects(withProp({ type: "string", minLength: -1 }), "parameters.properties.x.minLength");
    rejects(withProp({ type: "array", items: { type: "string" }, maxItems: 1.5 }), "parameters.properties.x.maxItems");
    rejects(withProp({ type: "number", minimum: "0" }), "parameters.properties.x.minimum must be a finite number");
    rejects(withProp({ type: "number", maximum: Number.POSITIVE_INFINITY }), "parameters.properties.x.maximum");
  });

  it("rejects a bound on a schema type it does not apply to", () => {
    rejects(withProp({ type: "string", minItems: 1 }), "parameters.properties.x.minItems and maxItems require an array schema");
    rejects(withProp({ type: "number", maxLength: 3 }), "parameters.properties.x.minLength and maxLength require a string schema");
    rejects(withProp({ type: "string", minimum: 1 }), "parameters.properties.x.minimum and maximum require a numeric schema");
  });

  it("rejects a minimum above its maximum", () => {
    rejects(withProp({ type: "array", items: { type: "string" }, minItems: 3, maxItems: 2 }), "parameters.properties.x.minItems must not exceed maxItems");
    rejects(withProp({ type: "string", minLength: 5, maxLength: 4 }), "parameters.properties.x.minLength must not exceed maxLength");
    rejects(withProp({ type: "integer", minimum: 2, maximum: 1 }), "parameters.properties.x.minimum must not exceed maximum");
  });

  it("checks required names, array items, enum and default values against the schema", () => {
    rejects({ type: "object", properties: { a: { type: "string" } }, required: ["b"] }, "parameters.required must reference declared properties");
    rejects({ type: "object", properties: { a: { type: "string" } }, required: ["a", "a"] }, "parameters.required must not contain duplicates");
    rejects(withProp({ type: "array" }), "parameters.properties.x.items is required for array schemas");
    rejects(withProp({ type: "string", items: { type: "string" } }), "parameters.properties.x.items requires an array schema");
    rejects(withProp({ type: "string", enum: ["a", 1] }), "parameters.properties.x.enum values must match the schema type");
    rejects(withProp({ type: "string", enum: ["a", "a"] }), "parameters.properties.x.enum values must be unique");
    rejects(withProp({ type: "integer", default: "three" }), "parameters.properties.x.default must match the schema type");
    rejects(withProp({ type: "string", pattern: "(" }), "parameters.properties.x.pattern must be a valid regular expression");
  });
});
