// POST /api/memory/ingest-path: which folder may be read into memory. A folder
// of credentials and the app's data dir are refused by what they are, not by
// how the path names them.
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveIngestRoot } from "./memory-ingest-root.js";
import { realpathDeep } from "../workspace/paths.js";

const WINDOWS = process.platform === "win32";

describe("resolveIngestRoot", () => {
  let root: string;
  let lax: string;
  const before = process.env.LAX_DATA_DIR;
  const shortName = (p: string): string => {
    try {
      const out = execSync(`cmd /c for %I in ("${p}") do @echo %~sI`, { encoding: "utf8" }).trim();
      return out.toLowerCase() === p.toLowerCase() ? "" : out;
    } catch { return ""; }
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "lax-ingest-root-"));
    lax = join(root, "laxdata");
    for (const dir of [lax, join(lax, "sessions"), join(root, ".aws"), join(root, "exports")]) mkdirSync(dir);
    process.env.LAX_DATA_DIR = lax;
  });
  afterAll(() => {
    if (before === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = before;
    rmSync(root, { recursive: true, force: true });
  });

  it("gives back the real path of an ordinary folder", () => {
    expect(resolveIngestRoot(join(root, "exports"))).toEqual({ root: realpathDeep(join(root, "exports")) });
  });

  it("refuses a folder of credentials, the data dir and a folder inside it", () => {
    expect(resolveIngestRoot(join(root, ".aws"))).toEqual({ refused: "sensitive" });
    expect(resolveIngestRoot(lax)).toEqual({ refused: "sensitive" });
    expect(resolveIngestRoot(join(lax, "sessions"))).toEqual({ refused: "sensitive" });
    expect(resolveIngestRoot(join(root, "exports", "..", ".aws"))).toEqual({ refused: "sensitive" });
  });

  it.skipIf(!WINDOWS)("refuses them under another casing, a trailing dot or an 8.3 short name", () => {
    expect(resolveIngestRoot(join(root, ".AWS"))).toEqual({ refused: "sensitive" });
    expect(resolveIngestRoot(join(root, "LAXDATA", "SESSIONS"))).toEqual({ refused: "sensitive" });
    expect(resolveIngestRoot(join(root, ".aws."))).toEqual({ refused: "sensitive" });
    expect(resolveIngestRoot(join(root, "laxdata.", "sessions"))).toEqual({ refused: "sensitive" });
    const shortAws = shortName(join(root, ".aws"));
    if (shortAws) expect(resolveIngestRoot(shortAws)).toEqual({ refused: "sensitive" });
  });
});
