import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, utimesSync, realpathSync, type readdir as fsReaddir } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { globTool, walkBounded, MAX_DEPTH, MAX_SCAN, WALK_CONCURRENCY, type WalkFs } from "./glob-tool.js";
import { renderToolResultForModel } from "./result-helpers.js";

// The glob walk used to be unbounded: no depth or readdir-concurrency cap (a
// symlink cycle or a link into a huge tree walked until ELOOP with the error
// swallowed), every match collected and stat()ed before the 200-entry limit
// applied last. Because glob is readOnly+concurrencySafe the executor batches
// N of them in one Promise.all, and the Aug 30 OOM (3.9GB heap, 126-206
// pending FSReqCallbacks) was that fan-out. These tests pin the bounds, the
// symlink-following the product depends on, AND the unchanged ordinary output.

let root: string;

function file(rel: string, content = "", mtimeSec?: number): string {
	const abs = join(root, rel);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, content);
	if (mtimeSec !== undefined) utimesSync(abs, mtimeSec, mtimeSec);
	return abs;
}

const run = (pattern: string, path: string) => globTool.execute({ pattern, path });

beforeAll(() => {
	// realpath: macOS tmpdir is a symlink into /private/var and the tool emits
	// whatever spelling it is given as `path`.
	root = realpathSync(mkdtempSync(join(tmpdir(), "glob-tool-")));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("glob tool — ordinary output is unchanged", () => {
	it("renders a small tree exactly as before (pinned fixture)", async () => {
		const dir = join(root, "pinned");
		file("pinned/src/a.ts", "hello", 1_700_000_000);
		file("pinned/src/b.ts", "x".repeat(2048), 1_700_000_100);

		const res = await run("**/*.ts", dir);
		expect(res.content).toBe(`${dir}/src/b.ts  (2.0K)\n${dir}/src/a.ts  (5B)`);
		expect(res.isError).toBeUndefined();
		expect(res.metadata).toEqual({ pattern: "**/*.ts", cwd: dir, count: 2, duration_ms: expect.any(Number) });

		// The rendered envelope header carries no new keys in the common case.
		const rendered = renderToolResultForModel(res);
		expect(rendered.startsWith(`[ok, pattern="**/*.ts", cwd=`)).toBe(true);
		expect(rendered).toMatch(/, count=2, duration_ms=\d+\]\n/);
		expect(rendered).not.toContain("capped");
		expect(rendered).not.toContain("scan_truncated");
		expect(rendered).not.toContain("WARNING");
	});

	it("reports no matches exactly as before", async () => {
		const dir = join(root, "pinned");
		const res = await run("**/*.nope", dir);
		expect(res.content).toBe("No files matched.");
		expect(res.metadata).toEqual({ pattern: "**/*.nope", cwd: dir, count: 0, duration_ms: expect.any(Number) });
	});

	it("tells the model about the depth and scan bounds so it can re-root with path", () => {
		expect(globTool.description).toContain(`${MAX_DEPTH} directory levels`);
		expect(globTool.description).toContain(`${MAX_SCAN} matches`);
		expect(Object.keys((globTool.parameters as { properties: object }).properties)).toEqual(["pattern", "path"]);
	});
});

describe("glob tool — symlinks are followed (the product depends on it)", () => {
	it.skipIf(process.platform === "win32")(
		"traverses a symlinked child dir named workspace — the packaged app's <cwd>/workspace bridge",
		async () => {
			// workspace/lifecycle.ts ensureWorkspaceLink makes <cwd>/workspace a dir
			// symlink (junction on win32) to the configured workspace, and the
			// default search root IS that cwd. A walk that skipped links returned
			// "No files matched." for every user file.
			const dir = join(root, "bridge");
			file("bridge-target/photos/cat.png", "png");
			mkdirSync(dir, { recursive: true });
			symlinkSync(join(root, "bridge-target"), join(dir, "workspace"), "dir");

			const res = await run("**/*.png", dir);
			expect(res.content).toBe(`${dir}/workspace/photos/cat.png  (3B)`);
		},
	);

	it.skipIf(process.platform === "win32")("a search root that is itself a symlink works", async () => {
		const dir = join(root, "lr");
		file("lr/src/a.ts", "a");
		symlinkSync(join(dir, "src"), join(dir, "linkroot"));
		const res = await run("**/*.ts", join(dir, "linkroot"));
		expect(res.content).toBe(`${dir}/linkroot/a.ts  (1B)`);
	});
});

describe("glob tool — the walk is bounded", () => {
	it.skipIf(process.platform === "win32")("a symlink cycle terminates at the depth bound", async () => {
		const dir = join(root, "cycle");
		file("cycle/src/a.ts", "a");
		symlinkSync(dir, join(dir, "src", "loop")); // cycle back to the search root

		// Pre-fix this walked src/loop/src/loop/... until ELOOP. Now a.ts shows up
		// once per lap until the lap's `src` dir would sit deeper than MAX_DEPTH:
		// lap k puts it at level 2k+1, so k ≤ (MAX_DEPTH-1)/2.
		const laps = Math.floor((MAX_DEPTH - 1) / 2) + 1;
		const res = await run("**/*.ts", dir);
		const lines = res.content.split("\n");
		expect(res.isError).toBeUndefined();
		expect(lines).toHaveLength(laps);
		for (const line of lines) {
			expect(line.startsWith(`${dir}/src/`)).toBe(true);
			expect(line.endsWith("/a.ts  (1B)")).toBe(true);
			const rel = line.slice(dir.length + 1, line.indexOf("  ("));
			expect(rel.split("/").length).toBeLessThanOrEqual(MAX_DEPTH + 1);
		}
		expect(res.metadata).not.toHaveProperty("scan_truncated", true);
	});

	it(`enters ${MAX_DEPTH} nested directory levels below the pattern base and no more`, async () => {
		const dir = join(root, "deep");
		const level = (n: number) => Array.from({ length: n }, (_, i) => `l${i + 1}`).join("/");
		file("deep/l1/shallow.ts", "s", 1_700_000_300);
		file(`deep/${level(MAX_DEPTH)}/edge.ts`, "e", 1_700_000_200); // dir at level 12 → entered
		file(`deep/${level(MAX_DEPTH + 1)}/over.ts`, "o", 1_700_000_100); // dir at level 13 → not opened

		const res = await run("**/*.ts", dir);
		expect(res.content).toBe(`${dir}/l1/shallow.ts  (1B)\n${dir}/${level(MAX_DEPTH)}/edge.ts  (1B)`);
	});

	it("skips coverage/, .claude/worktrees/ and nested node_modules alongside the existing ignore list", async () => {
		const dir = join(root, "ignored");
		file("ignored/src/a.ts");
		file("ignored/.claude/skills/s.ts");
		for (const rel of [
			"coverage/lcov/x.ts",
			".claude/worktrees/w1/src/b.ts",
			"desktop/node_modules/m/c.ts",
			"node_modules/n/d.ts",
			"dist/e.ts",
			".git/f.ts",
			"vendor/g.ts",
		]) file(`ignored/${rel}`);

		expect((await run("**/*.ts", dir)).content).toBe(`${dir}/src/a.ts  (0B)`);
		// dot:false alone keeps a bare ** out of .claude; an explicit .claude/**
		// pattern walks in, and the worktrees entry is what keeps 150+ checkouts
		// out of the result.
		expect((await run(".claude/**/*.ts", dir)).content).toBe(`${dir}/.claude/skills/s.ts  (0B)`);
	});

	it(`cuts the walk off at ${MAX_SCAN} matches, keeps at most 200 entries and says so`, async () => {
		const dir = join(root, "wide");
		for (let d = 0; d < 10; d++) mkdirSync(join(dir, `d${d}`), { recursive: true });
		const total = MAX_SCAN + 100;
		for (let i = 0; i < total; i++) writeFileSync(join(dir, `d${i % 10}`, `f${i}.txt`), "");

		const res = await run("**/*.txt", dir);
		const lines = res.content.split("\n");
		expect(lines).toHaveLength(201);
		expect(lines[200]).toMatch(new RegExp(`^WARNING: the walk stopped after ${MAX_SCAN} matches`));
		expect(lines[200]).toContain("narrow the path");
		expect(res.isError).toBeUndefined();
		expect(res.metadata).toMatchObject({ count: 200, capped: true, scan_truncated: true });
	});

	it(`stops issuing readdir()s once ${MAX_SCAN} matches are in hand (destroy reaches the walker)`, async () => {
		// A virtual tree via fast-glob's fs seam: 400 dirs x 100 files. A walk that
		// only stopped LISTENING would still readdir all 401 directories.
		const DIRS = 400;
		const FILES = 100;
		let readdirs = 0;
		const dirent = (name: string, isDir: boolean) => ({
			name,
			isFile: () => !isDir,
			isDirectory: () => isDir,
			isSymbolicLink: () => false,
		});
		const readdir = (path: string, _opts: unknown, cb: (err: null, entries: unknown[]) => void) => {
			readdirs++;
			const entries = path === "/virtual"
				? Array.from({ length: DIRS }, (_, i) => dirent(`d${i}`, true))
				: Array.from({ length: FILES }, (_, i) => dirent(`f${i}.txt`, false));
			setImmediate(() => cb(null, entries));
		};
		// The adapter type is node's overloaded fs.readdir; this stub is only ever
		// called with the (path, {withFileTypes}, cb) form scandir uses.
		const fs: WalkFs = { readdir: readdir as unknown as typeof fsReaddir };

		const { paths, truncated } = await walkBounded("**/*.txt", "/virtual", fs);
		expect(truncated).toBe(true);
		expect(paths).toHaveLength(MAX_SCAN);
		const needed = Math.ceil(MAX_SCAN / FILES) + 1; // root + enough dirs to fill the cap
		expect(readdirs).toBeGreaterThanOrEqual(needed);
		expect(readdirs).toBeLessThanOrEqual(needed + 2 * WALK_CONCURRENCY); // only in-flight slack
		expect(readdirs).toBeLessThan(DIRS / 4);
	});
});
