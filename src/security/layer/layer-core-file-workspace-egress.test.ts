import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { uploadsDir } from "../../config.js";
import { platformRoot } from "../../platform-root.js";
import { CAN_CREATE_DIRECTORY_LINK } from "../../symlink-capabilities.test-helper.js";
import { mapUploadsRef } from "../../workspace/paths.js";
import { evaluateFileAccess } from "./file-access.js";
import { SecurityLayer } from "./layer-core.js";
import { evaluateWebFetch } from "./network-policy.js";

const DIRECTORY_LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

const WORKSPACE_ROOT = realpathSync(mkdtempSync(join(tmpdir(), "lax-ws-")));
const WORKSPACE = join(WORKSPACE_ROOT, "workspace");
mkdirSync(WORKSPACE, { recursive: true });
afterAll(() => rmSync(WORKSPACE_ROOT, { recursive: true, force: true }));
let savedLaxDir: string | undefined;
let suiteLaxDir: string;

beforeAll(() => {
  savedLaxDir = process.env.LAX_DATA_DIR;
  suiteLaxDir = mkdtempSync(join(tmpdir(), "layer-core-test-"));
  process.env.LAX_DATA_DIR = suiteLaxDir;
  writeFileSync(
    join(suiteLaxDir, "egress-allowlist.json"),
    JSON.stringify(["api.github.com", "example.com"]),
    "utf-8",
  );
});
afterAll(() => {
  if (savedLaxDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = savedLaxDir;
  rmSync(suiteLaxDir, { recursive: true, force: true });
});

describe("platform-source write guard (anchored to the install root)", () => {
  const ws = resolve(WORKSPACE);

  it("allows writing src/ inside a workspace app (Astro scaffold)", () => {
    const path = resolve(ws, "my-site/src/pages/index.astro");
    const d = evaluateFileAccess(ws, "common", () => false, "write", path);
    expect(d.allowed).toBe(true);
  });

  it("allows writing public/ inside a workspace app", () => {
    const path = resolve(ws, "my-site/public/favicon.ico");
    const d = evaluateFileAccess(ws, "common", () => false, "write", path);
    expect(d.allowed).toBe(true);
  });

  // allowedPathCheck true: asserts the guard outranks explicit session standing,
  // and clears unrestricted mode's outside-home check, which would otherwise
  // answer first here (test-env.ts relocates HOME to a throwaway dir).
  it("blocks writing the platform's own src/ even in unrestricted mode", () => {
    const path = resolve(platformRoot(), "src/server/routes.ts");
    const d = evaluateFileAccess(ws, "unrestricted", () => true, "write", path);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/platform files/i);
  });

  it("blocks writing the platform's own public/ even in unrestricted mode", () => {
    const path = resolve(platformRoot(), "public/app.html");
    const d = evaluateFileAccess(ws, "unrestricted", () => true, "write", path);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/platform files/i);
  });

  it("allows a workspace-app src/ write in unrestricted mode too", () => {
    const path = resolve(ws, "my-site/src/components/Hero.tsx");
    const d = evaluateFileAccess(ws, "unrestricted", () => false, "write", path);
    expect(d.allowed).toBe(true);
  });
});

// Relocated-workspace junction: the packaged app moves the workspace into
// ~/Documents and bridges <cwd>/workspace → there with a directory junction
// (symlink on POSIX). An agent reading an app file via the bridged path is
// lexically "outside" config.workspace but physically inside it. The
// containment check MUST follow the junction (realpath every segment) or every
// such read is wrongly blocked — the bug that surfaced as "BLOCKED by security:
// cannot read files outside project and user directories" on an app's own file.
describe("relocated-workspace junction is transparent to containment", () => {
  let realWs: string;
  let bridge: string; // a link that points INTO realWs, sitting elsewhere
  const linkable = CAN_CREATE_DIRECTORY_LINK;

  beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), "ws-junction-"));
    realWs = join(base, "real", "workspace");
    mkdirSync(join(realWs, "apps", "demo"), { recursive: true });
    writeFileSync(join(realWs, "apps", "demo", "index.html"), "<h1>hi</h1>", "utf-8");
    bridge = join(base, "bridge-workspace");
    if (linkable) symlinkSync(realWs, bridge, DIRECTORY_LINK_TYPE);
  });

  it.skipIf(!CAN_CREATE_DIRECTORY_LINK)("allows a read through the junction into the real workspace", () => {
    // config.workspace is the REAL location; the agent's path traverses the bridge.
    const viaBridge = join(bridge, "apps", "demo", "index.html");
    const d = evaluateFileAccess(realWs, "common", () => false, "read", viaBridge);
    expect(d.allowed).toBe(true);
  });

  it.skipIf(!CAN_CREATE_DIRECTORY_LINK)("still blocks a read that genuinely escapes the workspace", () => {
    const outside = join(bridge, "..", "..", "elsewhere", "secret.txt");
    const d = evaluateFileAccess(realWs, "common", () => false, "read", outside);
    expect(d.allowed).toBe(false);
  });
});

// A relative agent path must resolve the SAME way the file tool that opens it
// does (resolveAgentPath): anchored to the project root (workspace parent), not
// process.cwd(). This is what lets a relocated-workspace install read its own
// app files via the agent's "workspace/apps/<id>/..." convention without a
// false "outside project and user directories" block.
describe("relative agent paths anchor to the project root, not cwd", () => {
  const ws = resolve(WORKSPACE); // ends in /workspace, so parent is the project root

  it("allows a workspace-prefixed relative read (lands inside the workspace)", () => {
    const d = evaluateFileAccess(ws, "common", () => false, "read", "workspace/apps/demo/index.html");
    expect(d.allowed).toBe(true);
  });

  it("blocks a relative path that climbs out of the project root", () => {
    const d = evaluateFileAccess(ws, "workspace", () => false, "read", "../../../../../../etc/shadow");
    expect(d.allowed).toBe(false);
  });
});

// A non-image attachment lands in the LAX data dir's uploads folder under a
// hashed name; the model is handed a "/uploads/<f>" ref. The file tool resolves
// it via resolveAgentPath → uploadsDir(); the SecurityLayer gate MUST resolve it
// the SAME way (the shared mapUploadsRef) or it checks a root-level "/uploads/x",
// finds it outside the workspace, and DENIES the read in workspace/common mode —
// the exact "not in a searchable location in the workspace path" attachment
// failure. Regression for that resolver split-brain.
describe("attachment /uploads refs resolve like the file tool (no gate split-brain)", () => {
  let up: string;
  beforeAll(() => {
    up = uploadsDir(); // join(LAX_DATA_DIR, "uploads") — the suite beforeAll set LAX_DATA_DIR
    mkdirSync(up, { recursive: true });
    writeFileSync(join(up, "receipt.pdf"), "%PDF-1.4\n", "utf-8");
  });

  for (const mode of ["workspace", "common"] as const) {
    it(`${mode} mode: ALLOWS reading a /uploads attachment ref`, () => {
      const d = evaluateFileAccess(WORKSPACE, mode, () => false, "read", "/uploads/receipt.pdf");
      expect(d.allowed).toBe(true);
    });
  }

  it("did NOT blanket-allow: a non-/uploads path outside the workspace stays denied", () => {
    const d = evaluateFileAccess(WORKSPACE, "workspace", () => false, "read", "/etc/passwd");
    expect(d.allowed).toBe(false);
  });

  it("basename-confines a /uploads ref — '../auth.json' lands INSIDE uploads, never the real data-dir secret", () => {
    expect(mapUploadsRef("/uploads/../auth.json")).toBe(join(up, "auth.json"));
  });
});

// Egress mode is `permissive` by default — agent can surf the public web
// while SSRF/private-IP/cloud-metadata blocks remain in force. The previous
// deny-by-default model broke autonomous web research without adding real
// safety (allowlist file ≠ exfiltration defense). Strict mode is preserved
// for users who want it; secret-bearing requests are gated at the tool
// layer via the trusted-destinations check in web-tools.ts.
describe("egress mode semantics", () => {
  // Each test below isolates LAX_DATA_DIR to a fresh directory; the
  // outer suite's beforeAll fixture must not bleed in.
  function withLaxDir<T>(setup: (dir: string) => void, run: () => T): T {
    const dir = mkdtempSync(join(tmpdir(), "egress-mode-"));
    const prev = process.env.LAX_DATA_DIR;
    process.env.LAX_DATA_DIR = dir;
    try {
      setup(dir);
      return run();
    } finally {
      if (prev === undefined) delete process.env.LAX_DATA_DIR;
      else process.env.LAX_DATA_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("default permissive: missing config → public host allowed", () => {
    withLaxDir(
      () => { /* no security.json, no allowlist */ },
      () => {
        const sec = new SecurityLayer(WORKSPACE, "common");
        const d = sec.evaluate({
          toolName: "web_fetch",
          args: { url: "https://en.wikipedia.org/wiki/Anything" },
          sessionId: "t",
        });
        expect(d.allowed).toBe(true);
      },
    );
  });

  it("default permissive: SSRF still blocks private IPs", () => {
    withLaxDir(
      () => {},
      () => {
        const sec = new SecurityLayer(WORKSPACE, "common");
        const d = sec.evaluate({
          toolName: "http_request",
          args: { url: "http://169.254.169.254/latest/meta-data/" },
          sessionId: "t",
        });
        expect(d.allowed).toBe(false);
        expect(d.reason).toMatch(/metadata|private|reserved/i);
      },
    );
  });

  it("strict mode: missing allowlist → deny with setup hint", () => {
    withLaxDir(
      (dir) => writeFileSync(
        join(dir, "security.json"),
        JSON.stringify({ egressMode: "strict" }),
        "utf-8",
      ),
      () => {
        const sec = new SecurityLayer(WORKSPACE, "common");
        const d = sec.evaluate({
          toolName: "web_fetch",
          args: { url: "https://example.com" },
          sessionId: "t",
        });
        expect(d.allowed).toBe(false);
        expect(d.reason).toMatch(/strict.*no allowlist|egress-allowlist\.json/i);
      },
    );
  });

  it("strict mode: only allowlisted hosts pass", () => {
    withLaxDir(
      (dir) => {
        writeFileSync(
          join(dir, "security.json"),
          JSON.stringify({ egressMode: "strict" }),
          "utf-8",
        );
        writeFileSync(
          join(dir, "egress-allowlist.json"),
          JSON.stringify(["api.anthropic.com"]),
          "utf-8",
        );
      },
      () => {
        const sec = new SecurityLayer(WORKSPACE, "common");
        const allowed = sec.evaluate({
          toolName: "web_fetch",
          args: { url: "https://api.anthropic.com/v1/messages" },
          sessionId: "t",
        });
        expect(allowed.allowed).toBe(true);
        const denied = sec.evaluate({
          toolName: "web_fetch",
          args: { url: "https://example.com" },
          sessionId: "t",
        });
        expect(denied.allowed).toBe(false);
        expect(denied.reason).toMatch(/not in the egress allowlist/i);
      },
    );
  });

  it("evaluateWebFetch direct call: permissive default → public host allowed", () => {
    const d = evaluateWebFetch(new Set(), false, "7007", "https://example.com");
    expect(d.allowed).toBe(true);
  });

  it("evaluateWebFetch strict + missing → deny with setup hint", () => {
    const d = evaluateWebFetch(new Set(), false, "7007", "https://example.com", "strict");
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/strict.*no allowlist/i);
  });

  it("evaluateWebFetch: loopback host + allowlisted local service port → allowed", () => {
    const ports = new Set(["47831"]);
    for (const url of ["http://127.0.0.1:47831/health", "http://localhost:47831/health"]) {
      const d = evaluateWebFetch(new Set(), false, "7007", url, "permissive", ports);
      expect(d.allowed).toBe(true);
      expect(d.reason).toBe("Allowed local service");
    }
  });

  it("evaluateWebFetch: loopback host + port NOT in allowlist → still blocked", () => {
    const d = evaluateWebFetch(new Set(), false, "7007", "http://127.0.0.1:9999/health", "permissive", new Set(["47831"]));
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/private\/reserved/i);
  });

  it("evaluateWebFetch: loopback block on non-allowlisted port carries a localServicePorts recovery hint", () => {
    // Right-time hint for the original "can't verify my bridge" failure — the
    // model should learn it can allowlist its own service's port.
    for (const url of ["http://127.0.0.1:9999/health", "http://[::1]:9999/health", "http://localhost:9999/health"]) {
      const d = evaluateWebFetch(new Set(), false, "7007", url, "permissive", new Set(["47831"]));
      expect(d.allowed).toBe(false);
      expect(typeof d.recovery).toBe("string");
      expect(d.recovery).toMatch(/localServicePorts/);
    }
  });

  it("evaluateWebFetch: public host unaffected by local service ports", () => {
    const d = evaluateWebFetch(new Set(), false, "7007", "https://example.com", "permissive", new Set(["47831"]));
    expect(d.allowed).toBe(true);
  });

  it("evaluateWebFetch: non-loopback private IP + allowlisted port → still blocked", () => {
    const d = evaluateWebFetch(new Set(), false, "7007", "http://10.0.0.5:47831/health", "permissive", new Set(["47831"]));
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/private\/reserved/i);
  });

  it("SecurityLayer: localServicePorts from security.json gates loopback health-checks", () => {
    withLaxDir(
      (dir) => {
        writeFileSync(join(dir, "security.json"), JSON.stringify({ localServicePorts: [47831, "5050"] }), "utf-8");
      },
      () => {
        const sec = new SecurityLayer(WORKSPACE, "common");
        const allowed = sec.evaluate({
          toolName: "web_fetch",
          args: { url: "http://127.0.0.1:47831/health" },
          sessionId: "t",
        });
        expect(allowed.allowed).toBe(true);
        expect(allowed.reason).toBe("Allowed local service");
        const blocked = sec.evaluate({
          toolName: "web_fetch",
          args: { url: "http://127.0.0.1:9999/health" },
          sessionId: "t",
        });
        expect(blocked.allowed).toBe(false);
      },
    );
  });

  it("permissive + populated allowlist: any public host still allowed (allowlist gates secrets, not surfing)", () => {
    withLaxDir(
      (dir) => writeFileSync(
        join(dir, "egress-allowlist.json"),
        JSON.stringify(["api.anthropic.com"]),
        "utf-8",
      ),
      () => {
        const sec = new SecurityLayer(WORKSPACE, "common");
        const listed = sec.evaluate({
          toolName: "web_fetch",
          args: { url: "https://api.anthropic.com/v1/messages" },
          sessionId: "t",
        });
        expect(listed.allowed).toBe(true);
        const unlisted = sec.evaluate({
          toolName: "web_fetch",
          args: { url: "https://example.com" },
          sessionId: "t",
        });
        expect(unlisted.allowed).toBe(true);
      },
    );
  });
});

// The office/vision tools (spreadsheet/document/presentation/pdf/ocr/image)
// are kernel:"internal" and historically skipped file-access confinement
// entirely — an agent in "workspace only" mode could spreadsheet_read ANY xlsx
// on disk (the breach: reading ~/Documents/2024 May order.xlsx outside the
// workspace). Each now declares its caller path in TOOL_PATH_ARGS and is gated
// through the SAME evaluateFileAccess boundary as read/write. These tests pin
