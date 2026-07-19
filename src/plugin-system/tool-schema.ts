// Validation gate for untrusted declarative tool schemas. This accepts the
// serializable JSON-Schema subset already carried by ToolDefinition and every
// provider adapter; provider-specific or executable extensions fail closed.

const SCHEMA_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
const SCHEMA_KEYS = new Set([
  "type", "description", "title", "nullable", "enum", "const", "default",
  "properties", "required", "additionalProperties", "items",
  "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum",
  "format", "pattern",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJsonValue(value: unknown, path: string, ancestry: WeakSet<object>, depth: number): void {
  if (depth > 32) throw new Error(`${path} exceeds the supported schema depth`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain finite JSON numbers`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${path} is not JSON-serializable`);
  const object = value as object;
  if (ancestry.has(object)) throw new Error(`${path} contains a cycle`);
  ancestry.add(object);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, ancestry, depth + 1));
  } else {
    if (!isPlainObject(value)) throw new Error(`${path} must contain plain JSON objects`);
    for (const [key, item] of Object.entries(value)) {
      assertJsonValue(item, `${path}.${key}`, ancestry, depth + 1);
    }
  }
  ancestry.delete(object);
}

function assertNonNegativeInteger(value: unknown, path: string): void {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${path} must be a non-negative integer`);
}

function valueMatchesType(value: unknown, type: unknown, nullable: unknown): boolean {
  if (value === null) return type === "null" || nullable === true;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isPlainObject(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function validateSchemaNode(
  value: unknown,
  path: string,
  ancestry: WeakSet<object>,
  depth: number,
  root = false,
): void {
  if (!isPlainObject(value)) throw new Error(`${path} must be a plain object schema`);
  if (depth > 32) throw new Error(`${path} exceeds the supported schema depth`);
  if (ancestry.has(value)) throw new Error(`${path} contains a cycle`);
  ancestry.add(value);

  for (const key of Object.keys(value)) {
    if (!SCHEMA_KEYS.has(key)) throw new Error(`${path}.${key} is not a supported tool-schema keyword`);
  }
  if (typeof value.type !== "string" || !SCHEMA_TYPES.has(value.type)) {
    throw new Error(`${path}.type must be a supported JSON-schema type`);
  }
  if (root && value.type !== "object") throw new Error(`${path}.type must be object`);
  if (value.description !== undefined && typeof value.description !== "string") {
    throw new Error(`${path}.description must be a string`);
  }
  if (value.title !== undefined && typeof value.title !== "string") throw new Error(`${path}.title must be a string`);
  if (value.nullable !== undefined && typeof value.nullable !== "boolean") {
    throw new Error(`${path}.nullable must be a boolean`);
  }
  for (const key of ["format", "pattern"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") throw new Error(`${path}.${key} must be a string`);
  }
  if ((value.format !== undefined || value.pattern !== undefined) && value.type !== "string") {
    throw new Error(`${path}.format and pattern require a string schema`);
  }
  if (typeof value.pattern === "string") {
    try { new RegExp(value.pattern); } catch { throw new Error(`${path}.pattern must be a valid regular expression`); }
  }

  const properties = value.properties;
  if (root && !isPlainObject(properties)) throw new Error(`${path}.properties must be an object`);
  if (properties !== undefined) {
    if (value.type !== "object" || !isPlainObject(properties)) {
      throw new Error(`${path}.properties requires an object schema`);
    }
    for (const [name, schema] of Object.entries(properties)) {
      validateSchemaNode(schema, `${path}.properties.${name}`, ancestry, depth + 1);
    }
  }
  if (value.required !== undefined) {
    if (!Array.isArray(value.required) || value.required.some((name) => typeof name !== "string")) {
      throw new Error(`${path}.required must be a string array`);
    }
    const required = value.required as string[];
    if (new Set(required).size !== required.length) throw new Error(`${path}.required must not contain duplicates`);
    if (!isPlainObject(properties) || required.some((name) => !Object.hasOwn(properties, name))) {
      throw new Error(`${path}.required must reference declared properties`);
    }
  }
  if (value.additionalProperties !== undefined) {
    if (value.type !== "object") throw new Error(`${path}.additionalProperties requires an object schema`);
    if (typeof value.additionalProperties !== "boolean") {
      validateSchemaNode(value.additionalProperties, `${path}.additionalProperties`, ancestry, depth + 1);
    }
  }
  if (value.type === "array") {
    if (value.items === undefined) throw new Error(`${path}.items is required for array schemas`);
    validateSchemaNode(value.items, `${path}.items`, ancestry, depth + 1);
  } else if (value.items !== undefined) {
    throw new Error(`${path}.items requires an array schema`);
  }

  for (const key of ["minItems", "maxItems", "minLength", "maxLength"] as const) {
    if (value[key] !== undefined) assertNonNegativeInteger(value[key], `${path}.${key}`);
  }
  if ((value.minItems !== undefined || value.maxItems !== undefined) && value.type !== "array") {
    throw new Error(`${path}.minItems and maxItems require an array schema`);
  }
  if ((value.minLength !== undefined || value.maxLength !== undefined) && value.type !== "string") {
    throw new Error(`${path}.minLength and maxLength require a string schema`);
  }
  for (const key of ["minimum", "maximum"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key]))) {
      throw new Error(`${path}.${key} must be a finite number`);
    }
  }
  if ((value.minimum !== undefined || value.maximum !== undefined) && value.type !== "number" && value.type !== "integer") {
    throw new Error(`${path}.minimum and maximum require a numeric schema`);
  }
  if (typeof value.minItems === "number" && typeof value.maxItems === "number" && value.minItems > value.maxItems) {
    throw new Error(`${path}.minItems must not exceed maxItems`);
  }
  if (typeof value.minLength === "number" && typeof value.maxLength === "number" && value.minLength > value.maxLength) {
    throw new Error(`${path}.minLength must not exceed maxLength`);
  }
  if (typeof value.minimum === "number" && typeof value.maximum === "number" && value.minimum > value.maximum) {
    throw new Error(`${path}.minimum must not exceed maximum`);
  }

  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length === 0) throw new Error(`${path}.enum must be a non-empty array`);
    value.enum.forEach((item, index) => assertJsonValue(item, `${path}.enum[${index}]`, new WeakSet(), depth + 1));
    if (value.enum.some((item) => !valueMatchesType(item, value.type, value.nullable))) {
      throw new Error(`${path}.enum values must match the schema type`);
    }
    const encoded = value.enum.map((item) => JSON.stringify(item));
    if (new Set(encoded).size !== encoded.length) throw new Error(`${path}.enum values must be unique`);
  }
  for (const key of ["const", "default"] as const) {
    if (value[key] !== undefined) {
      assertJsonValue(value[key], `${path}.${key}`, new WeakSet(), depth + 1);
      if (!valueMatchesType(value[key], value.type, value.nullable)) {
        throw new Error(`${path}.${key} must match the schema type`);
      }
    }
  }
  ancestry.delete(value);
}

export function validateToolParameterSchema(value: unknown): asserts value is Record<string, unknown> {
  assertJsonValue(value, "parameters", new WeakSet(), 0);
  validateSchemaNode(value, "parameters", new WeakSet(), 0, true);
}
