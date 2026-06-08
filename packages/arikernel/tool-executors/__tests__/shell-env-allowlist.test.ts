import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock node:child_process so we capture the env handed to the spawned child
// without launching a real process. The fake child closes cleanly so
// ShellExecutor's spawnSafe promise resolves with success. This file is
// dedicated to the env-allowlist assertion because the module-level spawn mock
// would otherwise interfere with the real-spawn tests in shell-injection.test.ts.
let capturedEnv: Record<string, string | undefined> = {};
vi.mock("node:child_process", () => ({
	spawn: (
		_cmd: string,
		_args: readonly string[],
		options: { env?: Record<string, string | undefined> },
	) => {
		capturedEnv = options?.env ?? {};
		const child = new EventEmitter() as EventEmitter & {
			stdout: Readable;
			stderr: Readable;
		};
		child.stdout = Readable.from([]);
		child.stderr = Readable.from([]);
		process.nextTick(() => child.emit("close", 0));
		return child;
	},
}));

import { ShellExecutor } from "../src/shell.js";

// The full set the sanitizer is allowed to forward (mirrors shell.ts).
const ALLOWED = new Set([
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TERM",
	"TMPDIR",
	"SHELL",
	"PWD",
]);

describe("ShellExecutor environment allowlist (FIX 2)", () => {
	const executor = new ShellExecutor();

	afterEach(() => {
		delete process.env.DATABASE_URL;
		delete process.env.AWS_SECRET_ACCESS_KEY;
		delete process.env.SOME_RANDOM_APP_VAR;
		capturedEnv = {};
	});

	it("drops secret-shaped vars and forwards only allowlisted vars to the child", async () => {
		// DATABASE_URL is the canonical leak: its name contains none of the old
		// substring-denylist tokens, so a denylist would have forwarded it.
		process.env.DATABASE_URL = "postgres://user:pw@host/db";
		process.env.AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLE";
		process.env.SOME_RANDOM_APP_VAR = "leak-me";
		process.env.PATH = process.env.PATH || "/usr/bin";

		const result = await executor.execute({
			id: "tc-env-1",
			toolClass: "shell",
			action: "exec",
			parameters: { executable: "echo", args: ["hi"] },
		});
		expect(result.success).toBe(true);

		// Secret/arbitrary vars never reach the child.
		expect(capturedEnv.DATABASE_URL).toBeUndefined();
		expect(capturedEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
		expect(capturedEnv.SOME_RANDOM_APP_VAR).toBeUndefined();

		// Every key present is on the allowlist (LC_* family also permitted).
		for (const key of Object.keys(capturedEnv)) {
			expect(ALLOWED.has(key) || key.startsWith("LC_")).toBe(true);
		}

		// PATH (allowlisted) is forwarded so the child can resolve binaries.
		expect(capturedEnv.PATH).toBeDefined();
	});
});
