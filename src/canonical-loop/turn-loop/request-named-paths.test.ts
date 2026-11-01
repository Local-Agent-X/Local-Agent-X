import { describe, it, expect } from "vitest";
import { isFileShaped, missingNamedFiles, pathsNamedIn } from "./request-named-paths.js";

// The requests of the four Terminal-Bench 2.0 tasks whose named output was never
// written (2026-10-31), cut to the sentences that name paths.
const SCHEDULER = "Read /app/task_file/input_data/requests_bucket_1.jsonl and write /app/task_file/output_data/plan_b1.jsonl. No missing/duplicate ids; cost/latency must stay under the thresholds in /app/task_file/scripts/cost_model.py.";
const PROTEIN = "Write the gBlock to /app/gblock.txt using the ids in /app/pdb_ids.txt; keep the emission/excitation of the donor/acceptor pair.";

describe("pathsNamedIn", () => {
  it("reads every path-like token in order, once, with trailing punctuation dropped", () => {
    expect(pathsNamedIn(PROTEIN)).toEqual(["/app/gblock.txt", "/app/pdb_ids.txt", "emission/excitation", "donor/acceptor"]);
  });

  it("stops at twelve", () => {
    const many = Array.from({ length: 20 }, (_, i) => `/tmp/f${i}.txt`).join(" ");
    expect(pathsNamedIn(many)).toHaveLength(12);
  });
});

describe("isFileShaped", () => {
  it("takes anchored paths and relative ones ending in an extension", () => {
    for (const p of ["/app/program.py", "/app/data", "~/x", "./out", "../a/b", "src/app.ts"]) expect(isFileShaped(p), p).toBe(true);
  });

  it("leaves out pairs of words joined by a slash", () => {
    for (const p of ["cost/latency", "missing/duplicate", "prompt_len/64", "donor/acceptor"]) expect(isFileShaped(p), p).toBe(false);
  });
});

describe("missingNamedFiles", () => {
  const onDisk = new Set(["/app/task_file/input_data/requests_bucket_1.jsonl", "/app/task_file/scripts/cost_model.py", "/app/pdb_ids.txt"]);
  const exists = (abs: string) => onDisk.has(abs);
  const asIs = (p: string) => p;

  it("names the outputs not written yet, never the inputs that exist or prose", () => {
    expect(missingNamedFiles(SCHEDULER, asIs, exists)).toEqual(["/app/task_file/output_data/plan_b1.jsonl"]);
    expect(missingNamedFiles(PROTEIN, asIs, exists)).toEqual(["/app/gblock.txt"]);
  });

  it("is empty once every named file exists", () => {
    onDisk.add("/app/gblock.txt");
    expect(missingNamedFiles(PROTEIN, asIs, exists)).toEqual([]);
  });

  it("leaves out a path the resolver refuses", () => {
    expect(missingNamedFiles("fix /etc/shadow", () => { throw new Error("outside"); }, () => false)).toEqual([]);
  });
});
