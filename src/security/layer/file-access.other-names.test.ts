// A credential file or a security switch is refused by the file it is, not by
// how the path spells it. Windows opens one file under several names: an 8.3
// short name, a stream suffix, and (from a shell) a name with trailing dots.
import { execSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformRoot } from "../../platform-root.js";
import { evaluateFileAccess } from "./file-access.js";
import { isProtectedInstallPath } from "./install-root.js";
import { win32OpenedName } from "./on-disk-name.js";
import { openValidatedRead } from "./validated-io.js";

const WINDOWS = process.platform === "win32";

describe("win32OpenedName", () => {
  it("drops the dots and spaces that end a segment, and stream suffixes", () => {
    expect(win32OpenedName("C:\\Users\\me\\.aws.\\credentials")).toBe("C:\\Users\\me\\.aws\\credentials");
    expect(win32OpenedName("C:\\Users\\me\\.lax\\security.json.")).toBe("C:\\Users\\me\\.lax\\security.json");
    expect(win32OpenedName("C:\\Users\\me\\.ssh \\config. .")).toBe("C:\\Users\\me\\.ssh\\config");
    expect(win32OpenedName("C:/x/.lax::$INDEX_ALLOCATION/hooks.json::$DATA")).toBe("C:/x/.lax/hooks.json");
  });

  it("leaves ordinary names, dot segments and the drive alone", () => {
    expect(win32OpenedName("C:\\Users\\me\\notes.v2.txt")).toBe("C:\\Users\\me\\notes.v2.txt");
    expect(win32OpenedName("C:\\a\\.\\b\\..\\c")).toBe("C:\\a\\.\\b\\..\\c");
    expect(win32OpenedName("C:\\.env")).toBe("C:\\.env");
  });
});

describe("the install folder reached by another name", () => {
  const root = resolve(platformRoot());
  const sibling = (name: string, ...rest: string[]): string => join(dirname(root), name, ...rest);

  it("is protected by its own name, and a folder beside it is not", () => {
    expect(isProtectedInstallPath(join(root, "package.json"))).toBe(true);
    expect(isProtectedInstallPath(sibling(`${basename(root)}-other`, "package.json"))).toBe(false);
  });

  it.skipIf(!WINDOWS)("is protected with a trailing dot or space on its folder, or a stream suffix", () => {
    expect(isProtectedInstallPath(sibling(`${basename(root)}.`, "package.json"))).toBe(true);
    expect(isProtectedInstallPath(sibling(`${basename(root)}.`, "src", "index.ts"))).toBe(true);
    expect(isProtectedInstallPath(sibling(`${basename(root)} `, "package.json"))).toBe(true);
    expect(isProtectedInstallPath(sibling(`${basename(root)}::$INDEX_ALLOCATION`, "package.json"))).toBe(true);
    expect(isProtectedInstallPath(join(root, "src.", "index.ts."))).toBe(true);
  });
});

describe("a file reached by another name", () => {
  let root: string;
  let ws: string;
  let lax: string;
  const before = process.env.LAX_DATA_DIR;
  const read = (p: string): boolean => evaluateFileAccess(ws, "unrestricted", () => false, "read", p, undefined).allowed;
  const write = (p: string): boolean => evaluateFileAccess(ws, "unrestricted", () => false, "write", p, undefined).allowed;
  /** The 8.3 name Windows gave `p`, or "" where the volume keeps none. */
  const shortName = (p: string): string => {
    try {
      const out = execSync(`cmd /c for %I in ("${p}") do @echo %~sI`, { encoding: "utf8" }).trim();
      return out.toLowerCase() === p.toLowerCase() ? "" : out;
    } catch { return ""; }
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "lax-other-names-"));
    ws = join(root, "ws");
    lax = join(root, "laxdata");
    for (const dir of [ws, lax, join(root, ".aws"), join(root, "project")]) mkdirSync(dir);
    writeFileSync(join(root, ".aws", "credentials"), "[default]");
    writeFileSync(join(root, "project", ".env"), "KEY=value");
    writeFileSync(join(root, "notes.txt"), "plain");
    writeFileSync(join(lax, "security.json"), "{}");
    process.env.LAX_DATA_DIR = lax;
  });
  afterAll(() => {
    if (before === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = before;
    rmSync(root, { recursive: true, force: true });
  });

  it("still allows an ordinary file, and a dotenv read asked for by its own name", () => {
    expect(read(join(root, "notes.txt"))).toBe(true);
    expect(write(join(root, "notes.txt"))).toBe(true);
    expect(read(join(root, "project", ".env"))).toBe(true);
    expect(read(join(root, ".aws", "credentials"))).toBe(false);
    expect(write(join(lax, "security.json"))).toBe(false);
  });

  it.skipIf(!WINDOWS)("refuses a credential file under a trailing dot or a stream suffix", () => {
    expect(read(join(root, ".aws.", "credentials"))).toBe(false);
    expect(read(join(root, ".aws", "credentials."))).toBe(false);
    expect(read(join(root, ".aws", "credentials::$DATA"))).toBe(false);
    expect(read(join(root, ".AWS", "CREDENTIALS"))).toBe(false);
  });

  it.skipIf(!WINDOWS)("refuses a security switch under a trailing dot", () => {
    expect(write(join(lax, "security.json."))).toBe(false);
    expect(write(join(root, "laxdata.", "security.json"))).toBe(false);
    expect(write(join(lax, "security.json::$DATA"))).toBe(false);
  });

  it.skipIf(!WINDOWS)("refuses a credential file, and a dotenv file, under an 8.3 short name, at the gate and at the read", () => {
    const shortAws = shortName(join(root, ".aws"));
    const shortEnv = shortName(join(root, "project", ".env"));
    if (!shortAws || !shortEnv) return; // this volume keeps no short names: nothing to reach
    const creds = join(shortAws, "credentials");
    expect(read(creds)).toBe(false);
    expect(() => closeSync(openValidatedRead(creds).fd)).toThrow(/sensitive path/);
    // By its short name a dotenv file is not the read the gate lets through
    // with its values masked: the masking would not know it for one.
    expect(read(shortEnv)).toBe(false);
  });
});
