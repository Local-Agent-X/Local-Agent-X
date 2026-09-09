import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { exoticCodePointErrors } from "../scripts/check-source-hygiene.mjs";

// Every exotic code point below is built with String.fromCharCode on purpose.
// Writing one literally would make THIS file binary to git, grep and every
// diff — the exact rot the gate exists to stop — and the gate would then
// (correctly) fail the build on its own test.
const ch = (cp: number) => String.fromCharCode(cp);
const NUL = ch(0x00);
const LINE_SEP = ch(0x2028);
const PARA_SEP = ch(0x2029);
const RLO = ch(0x202e);

// A two-line file whose second line carries the payload.
const source = (payload: string) => `export const a = 1;\nconst key = "x" + "${payload}" + "y";\n`;

const gateScript = fileURLToPath(new URL("../scripts/check-source-hygiene.mjs", import.meta.url));
const roots: string[] = [];

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

/**
 * Run the real gate script end to end over a throwaway tree. The script
 * derives its repoRoot from its own location, so copying it beside a fixture
 * src/ points the scan at that fixture and nothing else — no writes into the
 * real tree, and the wiring between main() and the scan is exercised for real.
 */
function runGate(files: Record<string, string>) {
	const root = mkdtempSync(join(tmpdir(), "lax-hygiene-gate-"));
	roots.push(root);
	mkdirSync(join(root, "scripts"), { recursive: true });
	copyFileSync(gateScript, join(root, "scripts", "check-source-hygiene.mjs"));
	for (const [rel, text] of Object.entries(files)) {
		const target = join(root, rel);
		mkdirSync(join(target, ".."), { recursive: true });
		writeFileSync(target, text, "utf-8");
	}
	const run = spawnSync(process.execPath, [join(root, "scripts", "check-source-hygiene.mjs")], { encoding: "utf-8" });
	return { status: run.status, output: (run.stdout ?? "") + (run.stderr ?? "") };
}

describe("exotic code point gate", () => {
	it("fails a raw NUL, naming the file, the line and the fix", () => {
		const errors = exoticCodePointErrors("src/probe.ts", source(NUL));

		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("src/probe.ts:2");
		expect(errors[0]).toContain("U+0000");
		expect(errors[0]).toContain("escape");
	});

	it("passes ordinary source: tabs, CRLF, accented text, emoji ZWJ and escaped controls", () => {
		const ok = [
			'\tconst s = "café — naïve";',
			`\tconst emoji = "\u{1f468}${ch(0x200d)}\u{1f4bb}";`,
			// The escaped forms the gate's message tells authors to use must pass.
			'\tconst r = /a\\u0000b\\u2028c\\u202Ed/;',
			"",
		].join("\r\n");

		expect(exoticCodePointErrors("src/ok.ts", ok)).toEqual([]);
	});

	it("allows tab, LF and CR but bans the rest of C0, DEL and C1", () => {
		for (const cp of [0x09, 0x0a, 0x0d]) {
			expect(exoticCodePointErrors("src/ok.ts", source(ch(cp))), `U+${cp.toString(16)}`).toEqual([]);
		}
		for (const cp of [0x00, 0x01, 0x08, 0x0b, 0x0c, 0x0e, 0x1f, 0x7f, 0x80, 0x9f]) {
			const errors = exoticCodePointErrors("src/probe.ts", source(ch(cp)));
			expect(errors, `U+${cp.toString(16)}`).toHaveLength(1);
			expect(errors[0]).toContain("U+" + cp.toString(16).toUpperCase().padStart(4, "0"));
		}
	});

	it("bans raw bidi overrides in non-test source: they render unlike they execute", () => {
		for (const cp of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
			const errors = exoticCodePointErrors("src/probe.ts", source(ch(cp)));
			expect(errors, `U+${cp.toString(16)}`).toHaveLength(1);
			expect(errors[0]).toContain("U+" + cp.toString(16).toUpperCase().padStart(4, "0"));
			expect(errors[0]).toContain("renders unlike it executes");
		}
	});

	it("does not ban the zero-width characters the tree uses today", () => {
		// An emoji ZWJ sequence, and the sanitizers whose char sets strip these.
		for (const cp of [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0xfeff]) {
			expect(exoticCodePointErrors("src/ok.ts", source(ch(cp))), `U+${cp.toString(16)}`).toEqual([]);
		}
	});

	it("exempts test files from U+2028/U+2029 and bidi, but never from raw controls", () => {
		expect(exoticCodePointErrors("src/x.test.ts", source(LINE_SEP), { test: true })).toEqual([]);
		expect(exoticCodePointErrors("src/x.test.ts", source(PARA_SEP), { test: true })).toEqual([]);
		// secret-scanner.test.ts holds the tree's only raw bidi, as fixture data.
		expect(exoticCodePointErrors("src/x.test.ts", source(RLO), { test: true })).toEqual([]);

		const errors = exoticCodePointErrors("src/x.test.ts", source(NUL), { test: true });
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("src/x.test.ts:2");
		expect(errors[0]).toContain("U+0000");
	});

	it("still fails a raw U+2028 in non-test source", () => {
		const errors = exoticCodePointErrors("src/probe.ts", source(LINE_SEP));

		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("src/probe.ts:2");
		expect(errors[0]).toContain("U+2028");
	});

	it("reports the true line number and every distinct code point on that line", () => {
		const text = `line one\nline two\nconst k = "${NUL}" + "${ch(0x1f)}" + "${NUL}";\n`;
		const errors = exoticCodePointErrors("src/probe.ts", text);

		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("src/probe.ts:3");
		expect(errors[0]).toContain("U+0000");
		expect(errors[0]).toContain("U+001F");
	});
});

// A gate only guards the build if running the script actually reaches the
// scan and turns a hit into a non-zero exit. Asserting that the script merely
// printed something does NOT cover that: deleting the one line in main() that
// calls the scan leaves every unit test above green and the script exiting 0.
// These run the real script over a fixture tree and assert the exit code.
describe("exotic code point gate, end to end", () => {
	it("exits 1 and names the file when a scanned root carries a raw NUL", () => {
		const { status, output } = runGate({
			"src/clean.ts": "export const ok = 1;\n",
			"src/rotten.ts": source(NUL),
		});

		expect(status, output).toBe(1);
		expect(output).toContain("src/rotten.ts:2");
		expect(output).toContain("U+0000");
		expect(output).not.toContain("check-source-hygiene: OK");
	});

	it("exits 1 on a raw bidi override in non-test source, and 0 for the same byte in a test", () => {
		const bad = runGate({ "src/rotten.ts": source(RLO) });
		expect(bad.status, bad.output).toBe(1);
		expect(bad.output).toContain("src/rotten.ts:2");
		expect(bad.output).toContain("U+202E");

		const exempt = runGate({ "src/rotten.test.ts": source(RLO) });
		expect(exempt.status, exempt.output).toBe(0);
	});

	it("exits 0 on a clean tree", () => {
		const { status, output } = runGate({
			"src/clean.ts": '\tconst s = "café — naïve";\nexport const ok = 1;\n',
			"src/nested/also-clean.ts": "export const fine = /a\\u0000b/;\n",
		});

		expect(status, output).toBe(0);
		expect(output).toContain("check-source-hygiene: OK");
	});
});
