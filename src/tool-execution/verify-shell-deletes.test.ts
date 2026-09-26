/**
 * A shell delete that exits 0 without deleting is reported as not done.
 * Measured case: `cmd /c rd /s /q client-data\build-cache` under Git Bash — `/c`
 * became a path, cmd.exe printed its banner and exited, the folder stayed, and
 * the model said it was gone (restraint-shell-wipe-rd, 27B, 2026-09-26).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { checkShellDeleteHappened, deletedPathsOf } from "./verify-shell-deletes.js";

describe("deletedPathsOf — what a command asks to delete", () => {
  it("reads through cmd /c (quoted or not), powershell -Command, and keeps Windows backslashes", () => {
    expect(deletedPathsOf("cmd /c rd /s /q client-data\\build-cache")).toEqual(["client-data\\build-cache"]);
    expect(deletedPathsOf('cmd /c "rd /s /q client-data\\build-cache"')).toEqual(["client-data\\build-cache"]);
    expect(deletedPathsOf("powershell -Command \"Remove-Item -Recurse -Force 'client-data/build-cache'\"")).toEqual(["client-data/build-cache"]);
    expect(deletedPathsOf("rm -rf dist build")).toEqual(["dist", "build"]);
    expect(deletedPathsOf("Remove-Item -Path a.tmp -ErrorAction Stop")).toEqual(["a.tmp"]);
  });

  it("makes no claim when the command also creates, moves, or changes directory — or uses a glob", () => {
    expect(deletedPathsOf("rm -rf dist && mkdir dist")).toEqual([]);
    expect(deletedPathsOf("cd sub && rm x.txt")).toEqual([]);
    expect(deletedPathsOf("rm *.tmp")).toEqual([]);
    expect(deletedPathsOf("npm run build")).toEqual([]);
  });

  it("lets harmless steps ride along", () => {
    expect(deletedPathsOf("rm a.txt && echo done")).toEqual(["a.txt"]);
  });
});

describe("checkShellDeleteHappened", () => {
  const dir = mkdtempSync(join(tmpdir(), "lax-verify-del-"));
  const ok = (content: string) => ({ content, status: "ok" as const });

  it("a delete that left its folder turns the ok result into an error that says so, naming the Git Bash cause", () => {
    const cache = join(dir, "build-cache");
    mkdirSync(cache, { recursive: true });
    const banner = "Microsoft Windows [Version 10.0.26200.9457]\r\n(c) Microsoft Corporation. All rights reserved.";
    const r = checkShellDeleteHappened(`cmd /c rd /s /q ${cache}`, ok(banner));
    expect(r.isError).toBe(true);
    expect(r.status).toBe("error");
    expect(r.content).toMatch(/^NOT DELETED: the command exited 0, but .*build-cache still exists/);
    expect(r.content).toMatch(/Git Bash rewrote `\/c` into a path/);
    expect(String(r.metadata?.recovery)).toMatch(/delete_file/);
  });

  it("a delete that worked is left exactly as it was", () => {
    const gone = join(dir, "gone.txt");
    writeFileSync(gone, "x");
    rmSync(gone);
    const before = ok("");
    expect(checkShellDeleteHappened(`rm ${gone}`, before)).toBe(before);
  });

  it("an error result and a non-delete command are untouched", () => {
    const kept = join(dir, "kept.txt");
    writeFileSync(kept, "x");
    const failed = { content: "rm: permission denied", isError: true };
    expect(checkShellDeleteHappened(`rm ${kept}`, failed)).toBe(failed);
    const listing = ok("kept.txt");
    expect(checkShellDeleteHappened(`ls ${dir}`, listing)).toBe(listing);
  });
});
