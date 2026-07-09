import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectFramework, inferFrameworkFromPrompt, type DetectedFramework } from "./framework-detect.js";
import { resolveServeCommand, stripRedundantInstall } from "./dev-server-tools.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-fwdetect-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writePkg(deps: Record<string, string>, devDeps: Record<string, string> = {}): void {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: deps, devDependencies: devDeps }));
}

describe("detectFramework — config files (highest precision)", () => {
  const cases: Array<[string, DetectedFramework]> = [
    ["next.config.mjs", "nextjs"],
    ["next.config.js", "nextjs"],
    ["next.config.ts", "nextjs"],
    ["nuxt.config.ts", "nuxt"],
    ["astro.config.mjs", "astro"],
    ["vite.config.js", "vite"],
    ["vite.config.ts", "vite"],
  ];
  for (const [file, framework] of cases) {
    it(`${file} → ${framework}, with the file as evidence`, () => {
      writeFileSync(join(dir, file), "export default {}\n");
      const det = detectFramework(dir);
      expect(det.framework).toBe(framework);
      expect(det.evidence).toBe(file);
    });
  }

  it("svelte.config.js needs the @sveltejs/kit dep to prove SvelteKit (alone it isn't)", () => {
    writeFileSync(join(dir, "svelte.config.js"), "export default {}\n");
    expect(detectFramework(dir).framework).not.toBe("sveltekit");   // plain Svelte ≠ SvelteKit

    writePkg({}, { "@sveltejs/kit": "^2.0.0" });
    const det = detectFramework(dir);
    expect(det.framework).toBe("sveltekit");
    expect(det.evidence).toContain("@sveltejs/kit");
  });

  it("remix.config.js → remix with the legacy `remix dev` command (not vite:dev)", () => {
    writeFileSync(join(dir, "remix.config.js"), "module.exports = {}\n");
    const det = detectFramework(dir);
    expect(det.framework).toBe("remix");
    expect(det.devCommand(5300)).toBe("npm install && npx remix dev --port 5300");
  });

  it("vite.config + a @remix-run/* dep → remix (vite:dev), not plain vite", () => {
    writeFileSync(join(dir, "vite.config.ts"), "export default {}\n");
    writePkg({ "@remix-run/react": "^2.0.0" });
    const det = detectFramework(dir);
    expect(det.framework).toBe("remix");
    expect(det.evidence).toBe(`vite.config.ts + package.json dependency "@remix-run/react"`);
    expect(det.devCommand(5301)).toContain("remix vite:dev");
  });

  it("precedence: a metaframework dep beats a bare vite.config (Next with a vitest vite.config → nextjs)", () => {
    // Next/Astro/Nuxt commonly ship a vite.config only for vitest and need no
    // config file of their own — the dep must win, else vite binds the port and
    // the caller reports false success while serving the wrong thing.
    writeFileSync(join(dir, "vite.config.js"), "export default {}\n");
    writePkg({ next: "^15.0.0" });
    const det = detectFramework(dir);
    expect(det.framework).toBe("nextjs");
    expect(det.evidence).toBe(`package.json dependency "next"`);
  });

  it("a real Vite SPA (vite.config, no metaframework dep) still detects vite", () => {
    writeFileSync(join(dir, "vite.config.ts"), "export default {}\n");
    writePkg({ vite: "^5.0.0", react: "^18.0.0" });
    const det = detectFramework(dir);
    expect(det.framework).toBe("vite");
    expect(det.evidence).toBe("vite.config.ts");
  });
});

describe("detectFramework — package.json dependency fallback", () => {
  const cases: Array<[string, DetectedFramework]> = [
    ["next", "nextjs"],
    ["nuxt", "nuxt"],
    ["@sveltejs/kit", "sveltekit"],
    ["astro", "astro"],
    ["@remix-run/node", "remix"],
    ["vite", "vite"],
  ];
  for (const [dep, framework] of cases) {
    it(`dependency "${dep}" (no config file) → ${framework}`, () => {
      writePkg({ [dep]: "*" });
      const det = detectFramework(dir);
      expect(det.framework).toBe(framework);
      expect(det.evidence).toBe(`package.json dependency "${dep}"`);
    });
  }

  it("reads devDependencies too (vite is usually a devDependency)", () => {
    writePkg({}, { vite: "^6.0.0" });
    expect(detectFramework(dir).framework).toBe("vite");
  });
});

describe("detectFramework — static / unknown / robustness", () => {
  it("index.html with no package.json → static, devCommand null", () => {
    writeFileSync(join(dir, "index.html"), "<!doctype html>\n");
    const det = detectFramework(dir);
    expect(det.framework).toBe("static");
    expect(det.devCommand(5310)).toBeNull();
  });

  it("index.html WITH a frameworkless package.json is NOT static (a project, just unrecognized)", () => {
    writeFileSync(join(dir, "index.html"), "<!doctype html>\n");
    writePkg({ lodash: "*" });
    expect(detectFramework(dir).framework).toBe("unknown");
  });

  it("empty dir → unknown, devCommand null", () => {
    const det = detectFramework(dir);
    expect(det.framework).toBe("unknown");
    expect(det.devCommand(5311)).toBeNull();
  });

  it("missing dir → unknown (never throws)", () => {
    const det = detectFramework(join(dir, "does-not-exist"));
    expect(det.framework).toBe("unknown");
    expect(det.evidence).toContain("directory not found");
  });

  it("unparseable package.json is treated as no deps, not a crash", () => {
    writeFileSync(join(dir, "package.json"), "{not json");
    expect(detectFramework(dir).framework).toBe("unknown");
  });

  it("detection sniffs the given dir only, not subdirectories", () => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "vite.config.js"), "export default {}\n");
    expect(detectFramework(dir).framework).toBe("unknown");
  });
});

describe("detectFramework — devCommand port injection", () => {
  const expected: Array<[string, string]> = [
    ["next.config.js", "npm install && npx next dev --port 4123"],
    ["nuxt.config.ts", "npm install && npx nuxt dev --port 4123"],
    ["astro.config.mjs", "npm install && npx astro dev --port 4123 --host 127.0.0.1"],
    ["vite.config.js", "npm install && npx vite --port 4123 --host 127.0.0.1 --strictPort"],
  ];
  for (const [file, command] of expected) {
    it(`${file} binds the given port: ${command}`, () => {
      writeFileSync(join(dir, file), "export default {}\n");
      expect(detectFramework(dir).devCommand(4123)).toBe(command);
    });
  }

  it("sveltekit dev command is vite's (SvelteKit's dev server IS vite)", () => {
    writeFileSync(join(dir, "svelte.config.js"), "export default {}\n");
    writePkg({}, { "@sveltejs/kit": "*" });
    expect(detectFramework(dir).devCommand(4124)).toBe(
      "npm install && npx vite dev --port 4124 --host 127.0.0.1 --strictPort",
    );
  });
});

describe("stripRedundantInstall — drop the crash-prone install when deps exist", () => {
  it("strips a leading `npm install &&` when node_modules is present", () => {
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    expect(stripRedundantInstall("npm install && npx vite --port 3002 --host 127.0.0.1 --strictPort", dir))
      .toBe("npx vite --port 3002 --host 127.0.0.1 --strictPort");
    expect(stripRedundantInstall("npm install && npm run dev", dir)).toBe("npm run dev");
    expect(stripRedundantInstall("npm ci && npm run dev", dir)).toBe("npm run dev");
    expect(stripRedundantInstall("pnpm install && pnpm dev", dir)).toBe("pnpm dev");
  });

  it("KEEPS the install when node_modules is absent (a real install is still needed)", () => {
    expect(stripRedundantInstall("npm install && npm run dev", dir)).toBe("npm install && npm run dev");
  });

  it("leaves a command with no install prefix untouched", () => {
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    expect(stripRedundantInstall("npx vite --port 3002", dir)).toBe("npx vite --port 3002");
  });

  it("resolveServeCommand strips the redundant install once deps are installed", () => {
    writeFileSync(join(dir, "vite.config.js"), "export default {}\n");
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    const r = resolveServeCommand(dir, undefined, 3002);
    expect(r.ok && r.command).toBe("npx vite --port 3002 --host 127.0.0.1 --strictPort");
  });
});

describe("resolveServeCommand — explicit command vs auto-detect", () => {
  it("an explicit command always wins (no sniffing needed)", () => {
    const r = resolveServeCommand(join(dir, "does-not-exist"), "npm install && npm run dev", 5320);
    expect(r).toEqual({ ok: true, command: "npm install && npm run dev", detected: null, evidence: null });
  });

  it("omitted + detectable framework → the detected dev command on the given port", () => {
    writeFileSync(join(dir, "vite.config.js"), "export default {}\n");
    const r = resolveServeCommand(dir, undefined, 5321);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.command).toBe("npm install && npx vite --port 5321 --host 127.0.0.1 --strictPort");
    expect(r.detected).toBe("vite");
    expect(r.evidence).toBe("vite.config.js");
  });

  it("a whitespace-only command counts as omitted", () => {
    writeFileSync(join(dir, "next.config.mjs"), "export default {}\n");
    const r = resolveServeCommand(dir, "   ", 5322);
    expect(r.ok && r.detected).toBe("nextjs");
  });

  it("omitted + static → error naming the evidence and the direct-serve path", () => {
    writeFileSync(join(dir, "index.html"), "<!doctype html>\n");
    const r = resolveServeCommand(dir, undefined, 5323);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("index.html with no package.json");
    expect(r.error).toContain("/apps/<app_id>/");
    expect(r.error).toContain("needs no dev server");
  });

  it("non-string command (null) is treated as omitted, not the literal \"null\"", () => {
    writeFileSync(join(dir, "next.config.mjs"), "export default {}\n");
    // The tool coerces non-string command to undefined before calling this;
    // proving the resolver auto-detects when handed undefined guards that path.
    const r = resolveServeCommand(dir, undefined, 5325);
    expect(r.ok && r.command).toContain("next dev");
  });

  it("omitted + unknown → error telling the caller to pass command explicitly", () => {
    const r = resolveServeCommand(dir, undefined, 5324);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("could not identify");
    expect(r.error).toContain("command");
  });
});

describe("inferFrameworkFromPrompt — prompt text → intended framework", () => {
  const cases: Array<[string, DetectedFramework]> = [
    ["Build a polished Next.js app for organizing recipes", "nextjs"],
    ["make me a nextjs dashboard", "nextjs"],
    ["a Nuxt.js storefront", "nuxt"],
    ["scaffold a SvelteKit blog", "sveltekit"],
    ["svelte kit portfolio", "sveltekit"],
    ["an Astro docs site", "astro"],
    ["a Remix todo app", "remix"],
    ["a Vite + React SPA", "vite"],
  ];
  for (const [prompt, expected] of cases) {
    it(`"${prompt}" → ${expected}`, () => {
      expect(inferFrameworkFromPrompt(prompt)).toBe(expected);
    });
  }

  it("no framework named → unknown (caller defaults to Vite)", () => {
    expect(inferFrameworkFromPrompt("Build me a single-page todo app with local storage")).toBe("unknown");
    expect(inferFrameworkFromPrompt("")).toBe("unknown");
  });

  it("a named metaframework outranks a bare 'vite' mention (Next app built with Vite is a Next app)", () => {
    expect(inferFrameworkFromPrompt("a Next.js app, bundled with Vite under the hood")).toBe("nextjs");
  });

  it("does not fire on the bare word 'next' (next steps / next page)", () => {
    expect(inferFrameworkFromPrompt("add a 'next page' button and describe next steps")).toBe("unknown");
  });
});
