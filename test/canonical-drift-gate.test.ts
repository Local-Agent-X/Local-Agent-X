import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The structure kit's drift gate, run end to end over throwaway trees. The
// script reads the tree it is run in (cwd), so nothing touches this repo.
const gate = fileURLToPath(new URL("../src/app-scaffold/kit/check-canonical.mjs", import.meta.url));
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

function tree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "lax-canonical-gate-"));
	roots.push(root);
	write(root, files);
	return root;
}
function write(root: string, files: Record<string, string>) {
	for (const [rel, text] of Object.entries(files)) {
		mkdirSync(join(root, rel, ".."), { recursive: true });
		writeFileSync(join(root, rel), text, "utf-8");
	}
}
function run(root: string, ...args: string[]) {
	const r = spawnSync(process.execPath, [gate, ...args], { cwd: root, encoding: "utf-8" });
	return { status: r.status, output: (r.stdout ?? "") + (r.stderr ?? "") };
}
const fn = (body: string) => `export function slugify(s: string) { return ${body}; }\n`;

describe("canonical drift gate, one source root", () => {
	it("fails a name exported from two files and steers to one owner", () => {
		const root = tree({ "src/a.ts": fn("s"), "src/b.ts": fn("s.trim()") });
		const r = run(root, "--root", "src");
		expect(r.status).toBe(1);
		expect(r.output).toContain("Exported from more than one file");
		expect(r.output).toContain("slugify: src/a.ts, src/b.ts");
	});

	it("records the file count, and fails a third copy of a listed name", () => {
		const root = tree({ "src/a.ts": fn("s"), "src/b.ts": fn("s.trim()") });
		run(root, "--root", "src", "--write-ratchet");
		expect(readFileSync(join(root, ".canonical-drift"), "utf-8")).toContain("slugify src x2");
		expect(run(root, "--root", "src").status).toBe(0);
		write(root, { "src/c.ts": fn("s.toLowerCase()") });
		const r = run(root, "--root", "src");
		expect(r.status).toBe(1);
		expect(r.output).toContain("slugify: src/a.ts, src/b.ts, src/c.ts");
	});

	it("makes a shrink stick: fewer copies fail until --tighten lowers the count", () => {
		const root = tree({ "src/a.ts": fn("s"), "src/b.ts": fn("s"), "src/c.ts": fn("s") });
		run(root, "--root", "src", "--write-ratchet");
		rmSync(join(root, "src/c.ts"));
		const r = run(root, "--root", "src");
		expect(r.status).toBe(1);
		expect(r.output).toContain("slugify: now 2 files in src");
		run(root, "--root", "src", "--tighten");
		expect(readFileSync(join(root, ".canonical-drift"), "utf-8")).toContain("slugify src x2");
		expect(run(root, "--root", "src").status).toBe(0);
	});

	it("ignores tests, re-exports and excluded paths", () => {
		const root = tree({
			"src/a.ts": fn("s"),
			"src/a.test.ts": fn("s"),
			"src/index.ts": `export { slugify } from "./a.js";\n`,
			"src/vendor/copy.ts": fn("s"),
		});
		expect(run(root, "--root", "src", "--exclude", "src/vendor/").status).toBe(0);
	});

	it("holds a ratchet line written before file counts at its roots until --tighten records one", () => {
		const root = tree({ "src/a.ts": fn("s"), "src/b.ts": fn("s") });
		writeFileSync(join(root, ".canonical-drift"), "slugify src\n");
		expect(run(root, "--root", "src").status).toBe(0);
		run(root, "--root", "src", "--tighten");
		expect(readFileSync(join(root, ".canonical-drift"), "utf-8")).toContain("slugify src x2");
	});
});

describe("canonical drift gate, several roots", () => {
	it("still reports a name exported from two roots as a cross-root duplicate", () => {
		const root = tree({ "apps/web/src/h.ts": fn("s"), "apps/mobile/h.ts": fn("s") });
		const r = run(root, "--root", "apps/web/src", "--root", "apps/mobile");
		expect(r.status).toBe(1);
		expect(r.output).toContain("Exported from more than one source root");
	});
});
