/**
 * A parameter whose NAME carries the model's chat-template markers.
 *
 * muse, grep, run 19: every read/write/glob arrived with the template leaking
 * into the key, the value intact. Each failed validation as "missing required
 * field", so the model could not edit its file and gave up — scored as a model
 * failure.
 */
import { describe, expect, it } from "vitest";
import { repairMarkerKeys } from "./arg-repair.js";

const readSchema = { type: "object", properties: { path: { type: "string" }, offset: { type: "number" } }, required: ["path"] };

describe("repairMarkerKeys", () => {
  it("recovers the path from muse's real key", () => {
    const args = { 'read<|message|><atem:parameter name="path': "C:/w/grep.py" };
    const { coerced, fixes } = repairMarkerKeys(args, readSchema);
    expect(coerced).toEqual({ path: "C:/w/grep.py" });
    expect(fixes).toEqual(["path:recovered-from-template-key"]);
  });

  it("leaves a clean argument object untouched", () => {
    const args = { path: "C:/w/grep.py", offset: 1 };
    const { coerced, fixes } = repairMarkerKeys(args, readSchema);
    expect(coerced).toEqual(args);
    expect(fixes).toEqual([]);
  });

  it("never overwrites a property the model also sent properly", () => {
    const args = { path: "real.py", 'read<|message|><atem:parameter name="path': "leaked.py" };
    expect(repairMarkerKeys(args, readSchema).coerced).toMatchObject({ path: "real.py" });
  });

  it("ignores an unknown key with no marker, and a marker key naming nothing in the schema", () => {
    expect(repairMarkerKeys({ nonsense: 1 }, readSchema).fixes).toEqual([]);
    expect(repairMarkerKeys({ '<|message|>whatever': 1 }, readSchema).fixes).toEqual([]);
  });

  it("is a no-op without a schema", () => {
    const args = { 'read<|message|><atem:parameter name="path': "x" };
    expect(repairMarkerKeys(args, undefined).coerced).toEqual(args);
  });
});
