import { describe, it, expect } from "vitest";
import { detectBuildCommand, detectTestCommand, isTestFile, type FsProbe } from "./build-command.js";

// A fake project tree. Keys are absolute paths. A `true` value means the path
// merely exists (tsconfig, lockfile, the tsc bin); an object value is a
// readable JSON file (package.json). exists() is key-presence; readJson()
// returns the object or null.
function probeFrom(tree: Record<string, true | object>): FsProbe {
  return {
    exists: (p) => p in tree,
    readJson: (p) => {
      const v = tree[p];
      return v && typeof v === "object" ? v : null;
    },
  };
}

describe("detectBuildCommand", () => {
  it("uses the nearest project dir (subdir manifest), not the repo root — the monorepo/app case", () => {
    // The benchmark shape: edits deep under app/, which has its own
    // package.json + tsconfig + local tsc. Verify must run in app/, not the
    // outer repo root.
    const probe = probeFrom({
      "/repo/package.json": { name: "root" },
      "/repo/app/package.json": { name: "app" },
      "/repo/app/tsconfig.json": true,
      "/repo/app/node_modules/.bin/tsc": true,
    });
    const r = detectBuildCommand(["/repo/app/src/chat/ChatScreen.tsx"], probe);
    expect(r).toEqual({ command: "node_modules/.bin/tsc --noEmit", cwd: "/repo/app", kind: "typecheck" });
  });

  it("prefers the project's own typecheck script over a synthesized tsc", () => {
    const probe = probeFrom({
      "/p/package.json": { scripts: { typecheck: "tsc --noEmit", build: "vite build" } },
      "/p/tsconfig.json": true,
    });
    const r = detectBuildCommand(["/p/src/a.ts"], probe);
    expect(r).toEqual({ command: "npm run typecheck", cwd: "/p", kind: "typecheck" });
  });

  it("honors the hyphenated type-check alias", () => {
    const probe = probeFrom({ "/p/package.json": { scripts: { "type-check": "tsc -p ." } } });
    const r = detectBuildCommand(["/p/src/a.ts"], probe);
    expect(r).toEqual({ command: "npm run type-check", cwd: "/p", kind: "typecheck" });
  });

  it("picks the package manager from the lockfile", () => {
    const probe = probeFrom({
      "/p/package.json": { scripts: { typecheck: "tsc" } },
      "/p/pnpm-lock.yaml": true,
    });
    expect(detectBuildCommand(["/p/a.ts"], probe)?.command).toBe("pnpm run typecheck");
  });

  it("falls back to npx --no-install tsc when there's a tsconfig but no local binary", () => {
    const probe = probeFrom({ "/p/package.json": { name: "x" }, "/p/tsconfig.json": true });
    const r = detectBuildCommand(["/p/a.ts"], probe);
    expect(r).toEqual({ command: "npx --no-install tsc --noEmit", cwd: "/p", kind: "typecheck" });
  });

  it("falls back to the build script when there's no typecheck and no tsconfig", () => {
    const probe = probeFrom({ "/p/package.json": { scripts: { build: "webpack" } } });
    const r = detectBuildCommand(["/p/a.ts"], probe);
    expect(r).toEqual({ command: "npm run build", cwd: "/p", kind: "build" });
  });

  it("type-checks a bare tsconfig project with no package.json", () => {
    const probe = probeFrom({ "/p/tsconfig.json": true, "/p/node_modules/.bin/tsc": true });
    const r = detectBuildCommand(["/p/a.ts"], probe);
    expect(r).toEqual({ command: "node_modules/.bin/tsc --noEmit", cwd: "/p", kind: "typecheck" });
  });

  it("detects Rust and Go projects", () => {
    expect(detectBuildCommand(["/r/src/main.rs"], probeFrom({ "/r/Cargo.toml": true })))
      .toEqual({ command: "cargo check", cwd: "/r", kind: "check" });
    expect(detectBuildCommand(["/g/main.go"], probeFrom({ "/g/go.mod": true })))
      .toEqual({ command: "go build ./...", cwd: "/g", kind: "check" });
  });

  it("returns null when no buildable project is found (never fabricates a verify)", () => {
    expect(detectBuildCommand(["/x/y/z.ts"], probeFrom({}))).toBeNull();
    expect(detectBuildCommand([], probeFrom({}))).toBeNull();
  });

  it("returns null for a package.json with no typecheck/build script and no tsconfig", () => {
    const probe = probeFrom({ "/p/package.json": { name: "lib", scripts: { start: "node ." } } });
    expect(detectBuildCommand(["/p/a.ts"], probe)).toBeNull();
  });

  it("when edits span projects, the most-edited one wins", () => {
    const probe = probeFrom({
      "/a/package.json": { scripts: { typecheck: "tsc" } },
      "/b/package.json": { scripts: { typecheck: "tsc" } },
    });
    // Two edits in /b, one in /a → build /b.
    const r = detectBuildCommand(["/a/x.ts", "/b/y.ts", "/b/z.ts"], probe);
    expect(r?.cwd).toBe("/b");
  });
});

describe("isTestFile", () => {
  it("recognizes test/spec files across extensions", () => {
    for (const p of ["a.test.ts", "x/b.spec.tsx", "c.test.js", "d.test.mjs", "e.spec.jsx"]) {
      expect(isTestFile(p)).toBe(true);
    }
    for (const p of ["a.ts", "test.ts", "b.testing.ts", "c.tsx", "spec.ts"]) {
      expect(isTestFile(p)).toBe(false);
    }
  });
});

describe("detectTestCommand", () => {
  it("runs the edited test file with the local vitest binary", () => {
    const probe = probeFrom({ "/p/package.json": { name: "x" }, "/p/node_modules/.bin/vitest": true });
    const r = detectTestCommand(["/p/src/foo.test.ts"], probe);
    expect(r).toEqual({ command: "node_modules/.bin/vitest run src/foo.test.ts", cwd: "/p" });
  });

  it("falls back to jest when there's no vitest binary", () => {
    const probe = probeFrom({ "/p/package.json": { name: "x" }, "/p/node_modules/.bin/jest": true });
    const r = detectTestCommand(["/p/a.spec.ts"], probe);
    expect(r).toEqual({ command: "node_modules/.bin/jest a.spec.ts", cwd: "/p" });
  });

  it("runs only the edited test files, not the whole suite (multiple files)", () => {
    const probe = probeFrom({ "/p/package.json": true, "/p/node_modules/.bin/vitest": true });
    const r = detectTestCommand(["/p/src/a.ts", "/p/src/x.test.ts", "/p/src/y.test.ts"], probe);
    expect(r).toEqual({ command: "node_modules/.bin/vitest run src/x.test.ts src/y.test.ts", cwd: "/p" });
  });

  it("returns null when no test file was edited", () => {
    const probe = probeFrom({ "/p/package.json": true, "/p/node_modules/.bin/vitest": true });
    expect(detectTestCommand(["/p/src/a.ts", "/p/src/b.ts"], probe)).toBeNull();
  });

  it("returns null when a test was edited but no runner is installed", () => {
    const probe = probeFrom({ "/p/package.json": true });
    expect(detectTestCommand(["/p/src/a.test.ts"], probe)).toBeNull();
  });

  it("picks the project with the most edited test files", () => {
    const probe = probeFrom({
      "/a/package.json": true, "/a/node_modules/.bin/vitest": true,
      "/b/package.json": true, "/b/node_modules/.bin/vitest": true,
    });
    const r = detectTestCommand(["/a/x.test.ts", "/b/y.test.ts", "/b/z.test.ts"], probe);
    expect(r?.cwd).toBe("/b");
  });
});
