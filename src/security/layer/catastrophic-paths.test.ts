// The delete floor that holds even in unrestricted mode: a folder is refused
// however its path is spelled. A target reaches the check as typed, so every
// spelling of a protected folder must be read as that folder.
import { describe, expect, it } from "vitest";
import { detectCatastrophicDelete, isCatastrophicDeleteTarget } from "./catastrophic-paths.js";
import type { DeleteCall } from "./shell-delete-targets.js";

const win = (t: string): boolean => isCatastrophicDeleteTarget(t, "C:\\Users\\me", "win32");
const nix = (t: string): boolean => isCatastrophicDeleteTarget(t, "/home/me", "linux");
const mac = (t: string): boolean => isCatastrophicDeleteTarget(t, "/Users/me", "darwin");

describe("isCatastrophicDeleteTarget: POSIX", () => {
  it.each([
    "/", "/*", "//", "/.", "~", "~/", "~/*", "~/.", "$HOME", "${HOME}", "$HOME/", "${HOME}/*",
    "/home/me", "/home/me/", "/home/me//", "/home/me/./", "/home/me/Downloads/..",
    "~/..", "/home/me/..", "/home/me/../me", "/home", "/home/",
    "/etc", "/etc/", "/etc//", "/./etc", "/etc/../etc", "/etc/nginx/nginx.conf",
    "/usr", "/usr/local/..", "/usr/local/../..", "/usr/bin/env", "/var", "/var/",
  ])("refuses %s", (target) => {
    expect(nix(target)).toBe(true);
  });

  it.each([
    "/home/me/Downloads", "~/Downloads/old", "$HOME/projects/app/dist", "/tmp/build", "/tmp/a/../b",
    "/var/lib/app/cache", "/usr/local", "/home/me/.cache", "/home/other", "$HOMEWORK", "~user",
    "dist", "./build", "../sibling", "",
  ])("allows %s", (target) => {
    expect(nix(target)).toBe(false);
  });

  it("refuses the folder above home on macOS, however it is reached", () => {
    expect(mac("/Users")).toBe(true);
    expect(mac("/Users/me/..")).toBe(true);
    expect(mac("/Users/me/../..")).toBe(true);
    expect(mac("/Users/me/Documents")).toBe(false);
  });
});

describe("isCatastrophicDeleteTarget: Windows", () => {
  it.each([
    "C:\\", "C:", "C:/", "c:\\", "D:\\", "/c", "/c/", "/c/*", "/mnt/c", "/cygdrive/c/",
    "C:\\Windows", "C:/Windows", "c:/windows/", "/c/Windows", "/mnt/c/Windows", "C:\\Windows\\System32", "C:/Windows/System32",
    "C:\\Users", "C:/Users", "C:/Users/", "/c/Users", "C:\\Users\\me", "C:/Users/me", "/c/Users/me", "/c/Users/me/",
    "C:\\Users\\me\\..", "C:/Users/me/Downloads/..", "C:\\Users\\me\\Downloads\\..\\..",
    "~", "~/", "~\\", "~/..", "$HOME", "%USERPROFILE%", "$env:USERPROFILE", "%USERPROFILE%\\..",
    "C:\\Program Files", "C:/Program Files/App", "C:\\ProgramData\\x",
  ])("refuses %s", (target) => {
    expect(win(target)).toBe(true);
  });

  it.each([
    "C:\\Users\\me\\Downloads", "C:/Users/me/Downloads/old", "/c/Users/me/projects/app/dist", "~/Downloads",
    "%USERPROFILE%\\Desktop\\old", "$env:USERPROFILE\\projects\\x", "C:\\Users\\other", "D:\\data\\cache",
    "/tmp/build", "dist", ".\\build", "..\\sibling",
  ])("allows %s", (target) => {
    expect(win(target)).toBe(false);
  });
});

describe("the home folder and what is above it", () => {
  it("refuses every folder above a home that is not under a well-known root", () => {
    const at = (t: string): boolean => isCatastrophicDeleteTarget(t, "/data/users/me", "linux");
    expect(at("/data/users/me")).toBe(true);
    expect(at("/data/users")).toBe(true);
    expect(at("/data")).toBe(true);
    expect(at("/data/users/me/../..")).toBe(true);
    expect(at("/data/users/other")).toBe(false);
    expect(at("/data/users/me/work")).toBe(false);
    expect(at("/database")).toBe(false);
  });

  it("reads a Windows home by Windows rules when the caller pins a POSIX platform", () => {
    const mixed = (t: string): boolean => isCatastrophicDeleteTarget(t, "C:\\Users\\me", "linux");
    expect(mixed("~")).toBe(true);
    expect(mixed("~/*")).toBe(true);
    expect(mixed("~/..")).toBe(true);
    expect(mixed("C:\\Users\\ME")).toBe(true);
    expect(mixed("~/Downloads")).toBe(false);
  });
});

describe("the floor's two strengths", () => {
  const del = (target: string): DeleteCall[] =>
    [{ verb: "rm", bin: "rm", recursive: true, forced: true, targets: [target], flags: ["-rf"], opaque: false } as unknown as DeleteCall];

  it("names the target it refused", () => {
    expect(detectCatastrophicDelete(del("/home/me/.."), "/home/me", "linux")).toContain("(/home/me/..)");
    expect(detectCatastrophicDelete(del("/home/me/Downloads"), "/home/me", "linux")).toBeNull();
  });

  it("on a disposable machine keeps the roots, and lets go of what is under a system folder", () => {
    const roots = { rootsOnly: true };
    expect(isCatastrophicDeleteTarget("/etc/nginx/sites-enabled/default", "/home/me", "linux", roots)).toBe(false);
    expect(isCatastrophicDeleteTarget("/etc//", "/home/me", "linux", roots)).toBe(true);
    expect(isCatastrophicDeleteTarget("~/..", "/home/me", "linux", roots)).toBe(true);
    expect(isCatastrophicDeleteTarget("/c/Users", "C:\\Users\\me", "win32", roots)).toBe(true);
  });
});
