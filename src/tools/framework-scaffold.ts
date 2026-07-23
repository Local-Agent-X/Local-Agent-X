/**
 * Per-framework scaffold via the framework's OFFICIAL creator, never a
 * hand-authored skeleton. A model hand-writing package.json/config/entry files
 * reproduces its stale training priors — wrong dep versions, the Tailwind-v4
 * `bg-white` trap, the Vite-config-leaked-into-Next hybrid. The official creator
 * emits TODAY's correct baseline by construction, so the whole class of skeleton
 * bugs disappears at the source.
 *
 * Each entry carries: the creator's fully non-interactive command (run with `.`
 * as target in the EMPTY app dir — it scaffolds in place, no prompts, at current
 * versions), and the LAX base-path patch to apply AFTER, which lives in a
 * DIFFERENT config key per framework (so assets resolve under the /apps/<id>/
 * proxy). `verified` marks the two creators checked non-interactive at runtime
 * (Vite, Next); the rest carry each tool's documented non-interactive flags.
 * `framework` is the prompt intent (inferFrameworkFromPrompt); anything unnamed
 * falls back to Vite + React, LAX's lightest, most reliable SPA stack.
 */
import type { DetectedFramework } from "./framework-detect.js";

interface FrameworkScaffold {
	label: string;
	/** Official creator, fully non-interactive, run in the empty app dir. */
	creator: string;
	/** LAX base-path config to apply after the creator runs. Framework-specific key. */
	basePatch: (appName: string) => string;
	/** True when the creator command was checked non-interactive at runtime. */
	verified?: boolean;
}

const SCAFFOLDS: Record<Exclude<DetectedFramework, "static" | "unknown">, FrameworkScaffold> = {
	vite: {
		label: "Vite + React",
		creator: "npm create vite@latest . -- --template react-ts",
		basePatch: (n) => `In vite.config.ts set \`base: '/apps/${n}/'\` AND the HMR client port to the dev port — \`server: { port: <P>, host: true, strictPort: true, hmr: { clientPort: <P>, host: 'localhost' } }\`. Without this, assets and hot-reload 404.`,
		verified: true,
	},
	nextjs: {
		label: "Next.js",
		creator: `npx create-next-app@latest . --ts --eslint --app --no-src-dir --no-tailwind --no-turbopack --import-alias "@/*" --use-npm --skip-install --yes`,
		basePatch: (n) => `In next.config.ts set \`basePath: '/apps/${n}', assetPrefix: '/apps/${n}'\` so assets resolve under the proxy. Next owns its own HMR — do NOT add a vite.config or an hmr.clientPort.`,
		verified: true,
	},
	nuxt: {
		label: "Nuxt",
		creator: "npx nuxi@latest init . --packageManager npm --gitInit false",
		basePatch: (n) => `Set \`app.baseURL: '/apps/${n}/'\` in nuxt.config. Nuxt owns its own bundler — do NOT add a standalone vite.config.`,
	},
	sveltekit: {
		label: "SvelteKit",
		creator: "npx sv create . --template minimal --types ts --no-add-ons --no-install",
		basePatch: (n) => `Set \`kit.paths.base: '/apps/${n}'\` in svelte.config.js (no trailing slash). SvelteKit owns its own bundler — do NOT add a standalone vite.config.`,
	},
	astro: {
		label: "Astro",
		creator: "npm create astro@latest . -- --template minimal --typescript strict --no-install --no-git --skip-houston --yes",
		basePatch: (n) => `Set \`base: '/apps/${n}/'\` in astro.config. Astro owns its own bundler — do NOT add a standalone vite.config.`,
	},
	remix: {
		label: "Remix",
		creator: "npx create-remix@latest . --no-install --no-git-init --yes",
		basePatch: (n) => `Set the vite \`base: '/apps/${n}/'\`. One framework only — do NOT add a second standalone vite.config.`,
	},
};

/** Resolve the scaffold for a prompt-inferred framework; unnamed/static → Vite default. */
function scaffoldFor(framework: DetectedFramework): FrameworkScaffold {
	if (framework === "static" || framework === "unknown") return SCAFFOLDS.vite;
	return SCAFFOLDS[framework] ?? SCAFFOLDS.vite;
}

/** App-relative path of the scaffold manifest the harness drops when it OWNS a
 *  build's baseline. Its presence + `ownedPaths` are what the write-guard keys
 *  the config-file lock on — one source of truth, read by both the runner
 *  (build-app-spawn) and the guard (write-guard). */
export const SCAFFOLD_MANIFEST_REL = ".lax/scaffold.json";

export interface ScaffoldManifest {
	framework: DetectedFramework;
	/** App-relative paths the harness generated and owns; the write-guard rejects
	 *  model writes/edits to these so the model can only add code under src/. */
	ownedPaths: string[];
}

export interface ScaffoldPlan {
	/** Shell commands run IN ORDER in the (empty) app dir. Fixed + trusted —
	 *  no interpolated user input, so no shell-injection surface. */
	commands: string[];
	/** Files written (OVERWRITING the creator's output) after the commands run —
	 *  the LAX-canonical vite.config + a Tailwind-v4 stylesheet entry. */
	files: { path: string; content: string }[];
	manifest: ScaffoldManifest;
}

// create-vite react-ts + a Tailwind-v4 install produce these; the harness owns
// them (writes them itself, then locks them) so the model can't downgrade the
// deps or leak a second framework's config into them.
const VITE_OWNED_PATHS = [
	"package.json",
	"package-lock.json",
	"vite.config.ts",
	"tsconfig.json",
	"tsconfig.app.json",
	"tsconfig.node.json",
];

/**
 * True when the harness runs the creator + owns the baseline for this framework,
 * rather than merely ADVISING the model to scaffold it. Scoped to the frontend-
 * spa default (Vite) — the proven clobber-and-serve failure. A named
 * metaframework (Next/Nuxt/…) keeps the advised-recipe path until its baseline
 * is owned too; extending this is adding a plan, not rearchitecting.
 */
export function harnessOwnsScaffold(framework: DetectedFramework): boolean {
	return framework === "vite" || framework === "unknown" || framework === "static";
}

/** The deterministic Vite + React + TS + Tailwind-v4 baseline the harness runs
 *  and owns. Pure — command/file STRINGS only; execution lives in
 *  build-app-spawn.ts (the audited subprocess boundary). */
export function viteScaffoldPlan(appName: string): ScaffoldPlan {
	return {
		commands: [
			"npm create vite@latest . -- --template react-ts",
			"npm install",
			"npm install tailwindcss @tailwindcss/vite",
		],
		files: [
			{ path: "vite.config.ts", content: viteConfigText(appName) },
			{ path: "src/index.css", content: `@import "tailwindcss";\n` },
		],
		manifest: { framework: "vite", ownedPaths: VITE_OWNED_PATHS },
	};
}

export function viteConfigText(appName: string): string {
	return `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// LAX reverse-proxies this app at /apps/${appName}/, so \`base\` makes asset URLs
// resolve there (without it they 404 — the "serve failure"). LAX_DEV_PORT is
// injected by app_serve_frontend; the HMR client must target the dev port
// directly because the proxy can't carry the HMR websocket. Omitting it (model
// runs vite by hand) falls back to Vite's default — assets still serve, only
// live hot-reload is lost.
const devPort = Number(process.env.LAX_DEV_PORT) || undefined

// Also injected by app_serve_frontend: the dev proxy below forwards
// /api/connectors/* to LAX stamped with the app-scoped connector capability
// (connectors-only — the same value LAX embeds in every served app page), so
// this app's API calls work even when the page is opened on the DEV origin
// itself (in-app browser, a pasted vite URL) where window.__LAX_CONNECTOR_TOKEN__
// is never injected. Without the env (vite run by hand) there's no proxy and
// the app only works behind /apps/${appName}/, as before.
const laxPort = Number(process.env.LAX_SERVER_PORT) || undefined
const connectorToken = process.env.LAX_CONNECTOR_TOKEN || ''

export default defineConfig({
  base: '/apps/${appName}/',
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    strictPort: true,
    ...(devPort ? { port: devPort, hmr: { clientPort: devPort, host: 'localhost' } } : {}),
    ...(laxPort ? {
      proxy: {
        '/api/connectors': {
          target: 'http://127.0.0.1:' + laxPort,
          changeOrigin: true,
          ...(connectorToken ? { headers: { authorization: 'Bearer ' + connectorToken } } : {}),
        },
      },
    } : {}),
  },
})
`;
}

/**
 * The scaffold RULES lines for a build prompt: run the framework's official
 * creator (never hand-write the skeleton), then apply the LAX base-path patch,
 * and use exactly one framework. Pure — string generation only.
 */
export function frontendScaffoldRecipeLines(appName: string, framework: DetectedFramework): string[] {
	const oneFramework =
		"- Use EXACTLY ONE framework. Do NOT scaffold a second framework's config alongside it (e.g. a Next app must not carry a standalone vite.config.js). Two competing configs leave one dead and the page blank.";
	const s = scaffoldFor(framework);
	return [
		`- Scaffold ${s.label} with its OFFICIAL creator — do NOT hand-write package.json, the framework config, or entry files. The creator emits the correct CURRENT-version skeleton by construction. The app dir is EMPTY; run this non-interactive command in it: \`${s.creator}\` (target \`.\` scaffolds in place, no prompts).`,
		`- Then apply the LAX base path so assets resolve under /apps/${appName}/: ${s.basePatch(appName)}`,
		oneFramework,
	];
}
