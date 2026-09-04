import { describe, it, expect } from "vitest";
import {
  detectBuildCommand,
  detectTestCommand,
  isTestFile,
  workspaceAppDir,
  workspaceAppSlug,
  type FsProbe,
} from "./build-command.js";

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

  it("uses build mode (tsc -b) for a Vite references-only solution tsconfig, where --noEmit checks nothing", () => {
    // The standard Vite/CRA-TS layout: root tsconfig lists no files, only
    // references. `tsc --noEmit` on it compiles zero files (silently green on a
    // broken app); `tsc -b` follows the references and catches the real errors.
    const probe = probeFrom({
      "/app/package.json": { scripts: { build: "tsc -b && vite build" } },
      "/app/tsconfig.json": { files: [], references: [{ path: "./tsconfig.app.json" }, { path: "./tsconfig.node.json" }] },
      "/app/node_modules/.bin/tsc": true,
    });
    const r = detectBuildCommand(["/app/src/lib/store.tsx"], probe);
    expect(r).toEqual({ command: "node_modules/.bin/tsc -b", cwd: "/app", kind: "typecheck" });
  });

  it("keeps --noEmit for a tsconfig that lists its own files (references present but not a pure solution config)", () => {
    const probe = probeFrom({
      "/app/package.json": { name: "app" },
      "/app/tsconfig.json": { include: ["src"], references: [{ path: "./tsconfig.node.json" }] },
      "/app/node_modules/.bin/tsc": true,
    });
    const r = detectBuildCommand(["/app/src/a.ts"], probe);
    expect(r).toEqual({ command: "node_modules/.bin/tsc --noEmit", cwd: "/app", kind: "typecheck" });
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

  // The workspace root holds LAX's OWN package.json + tsconfig.json, so an
  // unconfined walk-up out of an agent app anchors on LAX's TypeScript project.
  // Live incident: a static HTML clone was told `tsc --noEmit` had failed on
  // src/ari-kernel/grants.ts, a file the agent had never opened.
  describe("workspace app confinement", () => {
    // The agent's REAL workspace dir, as build-verify passes it in. The ceiling
    // is anchored to THIS root, not to the `workspace/apps/<x>` path shape.
    const WS = "/data/workspace";
    const workspace = {
      "/data/workspace/package.json": { name: "lax", scripts: { typecheck: "tsc --noEmit" } },
      "/data/workspace/tsconfig.json": true,
      "/data/workspace/node_modules/.bin/tsc": true,
    } as const;

    it("a static app with no manifest of its own is NOT verifiable — never the workspace's tsc", () => {
      const probe = probeFrom({ ...workspace });
      expect(detectBuildCommand(["/data/workspace/apps/clone/app.js"], probe, WS)).toBeNull();
      expect(detectBuildCommand(["/data/workspace/apps/clone/js/deep/main.js"], probe, WS)).toBeNull();
    });

    it("verifies the edited app's OWN project when it declares one", () => {
      const probe = probeFrom({
        ...workspace,
        "/data/workspace/apps/todo/package.json": { scripts: { typecheck: "tsc --noEmit" } },
      });
      const r = detectBuildCommand(["/data/workspace/apps/todo/src/a.ts"], probe, WS);
      expect(r?.cwd).toBe("/data/workspace/apps/todo");
    });

    it("a manifest-less app contributes no vote, so a sibling app's real project still wins", () => {
      const probe = probeFrom({
        ...workspace,
        "/data/workspace/apps/todo/package.json": { scripts: { typecheck: "tsc --noEmit" } },
      });
      const r = detectBuildCommand(
        ["/data/workspace/apps/clone/a.js", "/data/workspace/apps/clone/b.js", "/data/workspace/apps/todo/src/x.ts"],
        probe,
        WS,
      );
      expect(r?.cwd).toBe("/data/workspace/apps/todo");
    });

    it("matches the app prefix case-insensitively — a capitalized path must not escape either", () => {
      // Without case-insensitive matching this walks up to /data/Workspace and
      // type-checks LAX's own project, which is the incident. (On a case-
      // sensitive filesystem those are different dirs and must NOT be folded —
      // normPath folds only where the platform's filesystem does.)
      const probe = probeFrom({ "/data/Workspace/package.json": { scripts: { typecheck: "tsc" } } });
      expect(detectBuildCommand(["/data/Workspace/apps/Clone/app.js"], probe, "/data/Workspace")).toBeNull();
    });

    // The ceiling is a CEILING, not a search: a manifest that sits below the
    // edited file's own ancestry (`<app>/server/package.json` for an edit in
    // `<app>/shared`) is NOT borrowed. Building a directory the edit never
    // touched passes trivially and would promote the op to a false "✓ Verified".
    it("does not borrow a sibling SUB-project's manifest — no manifest above the file is a no-op", () => {
      const probe = probeFrom({
        ...workspace,
        "/data/workspace/apps/plane/server/package.json": { scripts: { typecheck: "tsc --noEmit" } },
      });
      expect(detectBuildCommand(["/data/workspace/apps/plane/shared/a.ts"], probe, WS)).toBeNull();
      // …but a file INSIDE that sub-project still verifies it, as always.
      expect(detectBuildCommand(["/data/workspace/apps/plane/server/a.ts"], probe, WS)?.cwd)
        .toBe("/data/workspace/apps/plane/server");
    });

    it("leaves projects OUTSIDE workspace/apps walking up as before", () => {
      const probe = probeFrom({ "/repo/package.json": { scripts: { typecheck: "tsc" } } });
      expect(detectBuildCommand(["/repo/apps/thing/src/a.ts"], probe, WS)?.cwd).toBe("/repo");
    });

    // The ceiling is anchored to the REAL workspace, not to the path shape:
    // `workspace/apps/<name>` is also the plain Turborepo/Nx layout under a
    // personal `~/workspace`. Shape-matching it ceilings the user's monorepo
    // BELOW its own root manifest, so nothing gets verified at all.
    it("a user's own ~/workspace/apps/<pkg> monorepo is NOT an agent app — it still verifies at its root", () => {
      const probe = probeFrom({
        ...workspace,
        "/home/me/workspace/package.json": { scripts: { typecheck: "tsc --noEmit" } },
      });
      expect(detectBuildCommand(["/home/me/workspace/apps/web/src/a.ts"], probe, WS)?.cwd)
        .toBe("/home/me/workspace");
    });

    // detectTestCommand shares nearestProjectDir, so it must be anchored the
    // same way or the two halves of one gate disagree about where a project ends.
    it("detectTestCommand is anchored identically — the same monorepo runs its own vitest", () => {
      const probe = probeFrom({
        ...workspace,
        "/home/me/workspace/package.json": { name: "mono" },
        "/home/me/workspace/node_modules/.bin/vitest": true,
      });
      expect(detectTestCommand(["/home/me/workspace/apps/web/src/a.test.ts"], probe, WS))
        .toEqual({ command: "node_modules/.bin/vitest run apps/web/src/a.test.ts", cwd: "/home/me/workspace" });
    });

    // With no root supplied there is NO ceiling — the pre-ceiling behavior —
    // rather than a guess at which `workspace/apps/<x>` is the agent's.
    it("without a workspace root there is no ceiling at all", () => {
      const probe = probeFrom({ ...workspace });
      expect(detectBuildCommand(["/data/workspace/apps/clone/app.js"], probe)?.cwd).toBe("/data/workspace");
    });

    // normPath's case-fold is NOT 1:1 per character: "İ".toLowerCase() is two
    // code units. Deriving the app dir from a match offset into the folded
    // spelling therefore returns a TRUNCATED path that equals no ancestor, the
    // ceiling never fires, and the walk-up escapes into the workspace's own
    // TypeScript project — the original incident, reachable through any Windows
    // profile name holding one of these characters.
    it("a path containing İ (case-fold is not length-preserving) still hits the ceiling", () => {
      const root = "/data/İİ/workspace";
      const probe = probeFrom({
        [`${root}/package.json`]: { name: "lax", scripts: { typecheck: "tsc --noEmit" } },
        [`${root}/tsconfig.json`]: true,
      });
      expect(workspaceAppDir(`${root}/apps/clone/app.js`, root)).toBe(`${root}/apps/clone`);
      expect(detectBuildCommand([`${root}/apps/clone/app.js`], probe, root)).toBeNull();
    });
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

// One parser for the `workspace/apps/<slug>` shape — the verify-gate's
// verifyTargetsEditedApp and the project walk-up above both read it from here.
describe("workspaceAppDir / workspaceAppSlug", () => {
  it("returns the app dir in the path's own spelling, for both separators", () => {
    expect(workspaceAppDir("/data/workspace/apps/todo/src/a.ts")).toBe("/data/workspace/apps/todo");
    expect(workspaceAppDir("C:\\Data\\Workspace\\apps\\Todo\\src\\a.ts")).toBe("C:\\Data\\Workspace\\apps\\Todo");
    expect(workspaceAppDir("workspace/apps/todo/a.js")).toBe("workspace/apps/todo");
  });

  it("returns null outside a workspace app", () => {
    expect(workspaceAppDir("/repo/src/a.ts")).toBeNull();
    expect(workspaceAppDir("/repo/apps/todo/a.ts")).toBeNull();
    expect(workspaceAppSlug("/repo/src/a.ts")).toBeNull();
  });

  it("agrees with the slug it is derived from", () => {
    expect(workspaceAppSlug("/data/workspace/apps/todo/src/a.ts")).toBe("todo");
    expect(workspaceAppSlug("C:\\Data\\Workspace\\apps\\Todo\\a.ts")).toBe("todo");
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
