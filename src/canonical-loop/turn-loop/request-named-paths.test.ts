import { describe, it, expect } from "vitest";
import { isFileShaped, locateNamedPath, missingNamedFiles, pathsNamedIn, rootsNamedIn } from "./request-named-paths.js";

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

  // Parity battery 2026-11-16: a session rooted elsewhere was told this
  // project's src/domain/index.ts was "not on disk" in 5 of 39 runs.
  it("reads a relative path under the folder the request names, by drive path too", () => {
    const request = "In the TypeScript project at C:\\Users\\me\\lax-parity-deep-rename-x1, rename `Money`. Update every caller, including the barrel `src/domain/index.ts` and src/api/new.ts.";
    const project = new Set(["C:/Users/me/lax-parity-deep-rename-x1/src/domain/index.ts"]);
    const sessionRoot = (p: string) => (/^[A-Za-z]:/.test(p) ? p.replace(/\\/g, "/") : `D:/session/${p}`);
    expect(missingNamedFiles(request, sessionRoot, (abs) => project.has(abs))).toEqual(["src/api/new.ts"]);
  });

  it("still names a relative file missing when no folder has it", () => {
    expect(missingNamedFiles("Write out/report.md for the data in /srv/data", (p) => p, (abs) => abs === "/srv/data")).toEqual(["out/report.md"]);
  });
});

describe("rootsNamedIn", () => {
  it("takes absolute folders, slash- or drive-anchored, without trailing punctuation", () => {
    expect(rootsNamedIn("Work in C:\\work\\shop, then /srv/app. Also cost/latency and src/a.ts.")).toEqual(["/srv/app", "C:\\work\\shop"]);
  });
});

describe("locateNamedPath", () => {
  const roots = ["/a", "/b"];
  it("keeps the session's reading when it exists, else the first named folder that has it", () => {
    expect(locateNamedPath("x.ts", roots, (p) => p, (abs) => abs === "x.ts")).toEqual({ abs: "x.ts", exists: true });
    expect(locateNamedPath("x.ts", roots, (p) => p, (abs) => abs === "/b/x.ts")).toEqual({ abs: "/b/x.ts", exists: true });
  });

  it("falls back to the session's reading when nothing has it, and never re-roots an absolute path", () => {
    expect(locateNamedPath("x.ts", roots, (p) => p, () => false)).toEqual({ abs: "x.ts", exists: false });
    expect(locateNamedPath("/c/x.ts", roots, (p) => p, () => false)).toEqual({ abs: "/c/x.ts", exists: false });
  });

  it("skips readings the resolver refuses, and is undefined when it refuses all", () => {
    const onlyB = (p: string) => { if (!p.startsWith("/b")) throw new Error("outside"); return p; };
    expect(locateNamedPath("x.ts", roots, onlyB, () => false)).toEqual({ abs: "/b/x.ts", exists: false });
    expect(locateNamedPath("x.ts", roots, () => { throw new Error("outside"); }, () => true)).toBeUndefined();
  });
});
