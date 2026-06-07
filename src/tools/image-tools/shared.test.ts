import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { resolve, join } from "node:path";
import { getRuntimeConfig, setRuntimeConfig } from "../../config.js";
import type { LAXConfig } from "../../types.js";
import { workspaceDir } from "./shared.js";

// Regression: generated media (images/videos) was written to a cwd-relative
// `workspace/<sub>` while the static server serves it from
// `resolve(config.workspace, <sub>)`. The packaged desktop app relocates the
// workspace to ~/Documents, so the two diverged and every freshly generated
// video 404'd → dead player in chat. workspaceDir() is the single chokepoint
// that must always agree with the server's resolution.

let saved: LAXConfig | undefined;

beforeEach(() => {
  try { saved = getRuntimeConfig(); } catch { saved = undefined; }
});

afterAll(() => {
  if (saved) setRuntimeConfig(saved);
});

describe("workspaceDir — media save/serve seam", () => {
  it("resolves against config.workspace exactly like the static file server", () => {
    // A relocated workspace distinct from the process cwd — the real packaged
    // case (config.workspace = <Documents>/Local Agent X).
    const relocated = resolve("/tmp/lax-test-docs/Local Agent X");
    setRuntimeConfig({ workspace: relocated } as unknown as LAXConfig);

    for (const sub of ["videos", "images"]) {
      // Contract: identical to request-handler's resolve(config.workspace, sub).
      expect(workspaceDir(sub)).toBe(resolve(relocated, sub));
      // And NOT the old cwd-relative path the bug produced.
      expect(workspaceDir(sub)).not.toBe(resolve(process.cwd(), "workspace", sub));
      expect(workspaceDir(sub)).not.toBe(join("workspace", sub));
    }
  });

  it("honors the dev/standalone relative default the same way the server does", () => {
    setRuntimeConfig({ workspace: "./workspace" } as unknown as LAXConfig);
    // Server does resolve(config.workspace, sub); workspaceDir must match.
    expect(workspaceDir("videos")).toBe(resolve("./workspace", "videos"));
  });
});
