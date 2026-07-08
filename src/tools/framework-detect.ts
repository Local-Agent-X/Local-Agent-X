/**
 * Framework detection for app DIRECTORIES — the canonical "what kind of
 * frontend project is this, and how does its dev server start?" axis.
 * (app-tier.ts classifies the PROMPT text before anything is built; this
 * module sniffs the tree that actually exists on disk. Different jobs.)
 *
 * Pure filesystem sniffing — no exec, and it never throws (a missing or
 * unreadable directory is just "unknown"). Precedence is config files first
 * (a framework's config file is the highest-precision signal), then
 * package.json dependencies, then a bare index.html with no package.json →
 * static. The returned devCommand binds the framework's own CLI to an
 * explicit port (and 127.0.0.1 where the CLI supports a host flag) so the
 * command works even when package.json has no "dev" script — LAX's
 * /apps/<id>/ reverse proxy needs the server on the exact port it was told.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type DetectedFramework =
  | "nextjs" | "nuxt" | "sveltekit" | "astro" | "remix" | "vite" | "static" | "unknown";

export interface FrameworkDetection {
  framework: DetectedFramework;
  /** What proved it, e.g. "next.config.mjs" or `package.json dependency "astro"`. */
  evidence: string;
  /** Dev command bound to the given port, or null for static/unknown. */
  devCommand(port: number): string | null;
}

// SvelteKit's dev server IS vite, so it gets the `vite dev` form. Remix here is
// the modern vite-based CLI (`remix vite:dev`); the legacy compiler (detected
// via remix.config.js) overrides this with plain `remix dev` below.
const DEV_COMMANDS: Partial<Record<DetectedFramework, (port: number) => string>> = {
  nextjs: (p) => `npm install && npx next dev --port ${p}`,
  nuxt: (p) => `npm install && npx nuxt dev --port ${p}`,
  sveltekit: (p) => `npm install && npx vite dev --port ${p} --host 127.0.0.1 --strictPort`,
  astro: (p) => `npm install && npx astro dev --port ${p} --host 127.0.0.1`,
  remix: (p) => `npm install && npx remix vite:dev --port ${p} --host 127.0.0.1`,
  vite: (p) => `npm install && npx vite --port ${p} --host 127.0.0.1 --strictPort`,
};

const CLASSIC_REMIX_COMMAND = (p: number) => `npm install && npx remix dev --port ${p}`;

const CONFIG_EXTS = ["js", "mjs", "ts"] as const;

/** First existing `<base>.{js,mjs,ts}` in appDir, or null. */
function firstConfig(appDir: string, base: string): string | null {
  for (const ext of CONFIG_EXTS) {
    const name = `${base}.${ext}`;
    if (existsSync(join(appDir, name))) return name;
  }
  return null;
}

/** dependencies + devDependencies merged; {} when package.json is absent or unparseable. */
function readDeps(appDir: string): Record<string, string> {
  try {
    const o = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return { ...(o.dependencies ?? {}), ...(o.devDependencies ?? {}) };
  } catch {
    return {};
  }
}

function make(
  framework: DetectedFramework,
  evidence: string,
  command?: (port: number) => string,
): FrameworkDetection {
  const cmd = command ?? DEV_COMMANDS[framework] ?? null;
  return { framework, evidence, devCommand: (port) => (cmd ? cmd(port) : null) };
}

// Prompt-text → intended framework. detectFramework sniffs the tree that
// exists on disk; this reads the ASK, before any file is written, so the
// builder prompt can hand the agent the recipe that matches the requested
// framework (Next → next.config basePath) instead of always teaching Vite —
// the mismatch that leaks a Vite config into a Next app (the hybrid). A named
// metaframework outranks a bare "vite" (a "Next.js app built with Vite" is a
// Next app), so those are checked first. "unknown" when nothing is named — the
// caller picks its own default (Vite+React for LAX's frontend-spa tier).
const PROMPT_FRAMEWORK_SIGNALS: ReadonlyArray<readonly [RegExp, DetectedFramework]> = [
  [/\bnext\.?js\b/i, "nextjs"],
  [/\bnuxt(?:\.?js)?\b/i, "nuxt"],
  [/\bsvelte\s?kit\b/i, "sveltekit"],
  [/\bastro\b/i, "astro"],
  [/\bremix\b/i, "remix"],
  [/\bvite\b/i, "vite"],
];

/**
 * Infer the framework a build PROMPT is asking for from its text, or "unknown"
 * when none is named. Pure string match — no disk, never throws.
 */
export function inferFrameworkFromPrompt(prompt: string): DetectedFramework {
  if (!prompt) return "unknown";
  for (const [re, framework] of PROMPT_FRAMEWORK_SIGNALS) {
    if (re.test(prompt)) return framework;
  }
  return "unknown";
}

/**
 * Sniff appDir and return the framework, the evidence that proved it, and the
 * dev command for a given port (null for static/unknown). Never throws.
 */
export function detectFramework(appDir: string): FrameworkDetection {
  if (!appDir || !existsSync(appDir)) {
    return make("unknown", `directory not found: ${appDir || "(empty path)"}`);
  }
  const deps = readDeps(appDir);
  const remixDep = Object.keys(deps).find((k) => k.startsWith("@remix-run/"));

  // 1) Config files — the highest-precision signal.
  const next = firstConfig(appDir, "next.config");
  if (next) return make("nextjs", next);
  const nuxt = firstConfig(appDir, "nuxt.config");
  if (nuxt) return make("nuxt", nuxt);
  // svelte.config.js alone is also plain Svelte; the kit dep proves SvelteKit.
  if (existsSync(join(appDir, "svelte.config.js")) && deps["@sveltejs/kit"]) {
    return make("sveltekit", `svelte.config.js + package.json dependency "@sveltejs/kit"`);
  }
  const astro = firstConfig(appDir, "astro.config");
  if (astro) return make("astro", astro);
  if (existsSync(join(appDir, "remix.config.js"))) {
    return make("remix", "remix.config.js", CLASSIC_REMIX_COMMAND);  // legacy compiler, not vite:dev
  }
  const vite = firstConfig(appDir, "vite.config");
  if (vite && remixDep) return make("remix", `${vite} + package.json dependency "${remixDep}"`);

  // 2) A metaframework DEPENDENCY outranks a bare vite.config. Next/Nuxt/Astro/
  // Kit projects routinely ship a vite.config solely for vitest, and Next/Astro
  // don't require their own config file — so treating vite.config as decisive
  // here would misread them as a plain Vite SPA. That misread isn't benign:
  // vite would start and bind the port, so the caller sees "listening" and
  // reports success while serving the wrong thing. The dep is the stronger
  // signal; check it before the vite.config fallback.
  const depOrder: ReadonlyArray<readonly [string, DetectedFramework]> = [
    ["next", "nextjs"],
    ["nuxt", "nuxt"],
    ["@sveltejs/kit", "sveltekit"],
    ["astro", "astro"],
  ];
  for (const [dep, framework] of depOrder) {
    if (deps[dep]) return make(framework, `package.json dependency "${dep}"`);
  }
  if (remixDep) return make("remix", `package.json dependency "${remixDep}"`);

  // 3) Vite — config file or bare dep — once metaframeworks are ruled out.
  if (vite) return make("vite", vite);
  if (deps["vite"]) return make("vite", `package.json dependency "vite"`);

  // 4) A bare index.html with no package.json is a static app — no dev server.
  if (!existsSync(join(appDir, "package.json")) && existsSync(join(appDir, "index.html"))) {
    return make("static", "index.html with no package.json");
  }
  return make("unknown", "no framework config file, no known package.json dependency, no bare index.html");
}
