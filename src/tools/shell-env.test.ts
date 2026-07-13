import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { buildSanitizedEnv, mergePathDirs } from "./shell-env.js";
import { withNodeTitleGuard, hardenChildEnv } from "./env-contamination.js";

// buildSanitizedEnv reads process.env; each test sets a var, asserts, restores.
const TOUCHED: string[] = [];
function setEnv(key: string, value: string): void {
  TOUCHED.push(key);
  process.env[key] = value;
}
afterEach(() => {
  for (const k of TOUCHED.splice(0)) delete process.env[k];
});

describe("buildSanitizedEnv credential scrubbing (R6-A1)", () => {
  it("drops connection strings carrying an embedded password regardless of var name", () => {
    // These names miss every credential-name pattern, and their ://user:pass@
    // punctuation also slips the high-entropy value gate — the exact leak.
    setEnv("DATABASE_URL", "postgres://admin:s3cr3tpw@db.internal:5432/prod");
    setEnv("MONGODB_URI", "mongodb://u:p@cluster0.example.net/app");
    setEnv("REDIS_URL", "redis://default:hunter2@cache.internal:6379");
    const env = buildSanitizedEnv();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.MONGODB_URI).toBeUndefined();
    expect(env.REDIS_URL).toBeUndefined();
  });

  it("drops generic *_KEY / *_PASS / *_PWD / *_DSN credential names", () => {
    setEnv("SUPABASE_KEY", "anon-key-value-here");
    setEnv("SMTP_PASS", "letmein");
    setEnv("MYSQL_PWD", "rootpw");
    setEnv("SENTRY_DSN", "https://pub@o0.ingest.sentry.io/0");
    const env = buildSanitizedEnv();
    expect(env.SUPABASE_KEY).toBeUndefined();
    expect(env.SMTP_PASS).toBeUndefined();
    expect(env.MYSQL_PWD).toBeUndefined();
    expect(env.SENTRY_DSN).toBeUndefined();
  });

  it("keeps a non-secret URL (no embedded credentials) — stays targeted, not hermetic", () => {
    setEnv("OLLAMA_HOST", "http://127.0.0.1:11434");
    setEnv("MY_SERVICE_URL", "https://api.example.com/v1");
    const env = buildSanitizedEnv();
    expect(env.OLLAMA_HOST).toBe("http://127.0.0.1:11434");
    expect(env.MY_SERVICE_URL).toBe("https://api.example.com/v1");
  });

  it("does not over-match innocuous names (BYPASS, MONKEY, OLDPWD)", () => {
    setEnv("FEATURE_BYPASS", "1");
    setEnv("MONKEY", "banana");
    const env = buildSanitizedEnv();
    expect(env.FEATURE_BYPASS).toBe("1");
    expect(env.MONKEY).toBe("banana");
  });

  it("still keeps the safe allowlist and still drops obvious key-named/high-entropy vars", () => {
    setEnv("LANG", "en_US.UTF-8");
    setEnv("OPENAI_API_KEY", "sk-" + "x".repeat(40));
    const env = buildSanitizedEnv();
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});

describe("buildSanitizedEnv host-contamination scrub (macOS app-bundle SIGSEGV)", () => {
  it("strips __CFBundleIdentifier so a child node's process.title set can't SIGSEGV", () => {
    // The exact contamination the Electron desktop injects: a child (vite v8 /
    // next / webpack) that sets process.title crashes in libuv →
    // CFBundleGetInfoDictionary against this inherited bundle. Must not pass through.
    setEnv("__CFBundleIdentifier", "com.localagentx.desktop");
    setEnv("__CF_USER_TEXT_ENCODING", "0x1F5:0x0:0x0");
    const env = buildSanitizedEnv();
    expect(env.__CFBundleIdentifier).toBeUndefined();
    expect(env.__CF_USER_TEXT_ENCODING).toBeUndefined();
  });

  it("strips the Electron fork IPC channel vars", () => {
    setEnv("NODE_CHANNEL_FD", "3");
    setEnv("NODE_CHANNEL_SERIALIZATION_MODE", "json");
    setEnv("ELECTRON_RUN_AS_NODE", "1");
    const env = buildSanitizedEnv();
    expect(env.NODE_CHANNEL_FD).toBeUndefined();
    expect(env.NODE_CHANNEL_SERIALIZATION_MODE).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it("keeps NODE_ENV / NODE_PATH — the prefix strip is scoped to NODE_CHANNEL_*, not all NODE_", () => {
    setEnv("NODE_ENV", "development");
    const env = buildSanitizedEnv();
    expect(env.NODE_ENV).toBe("development");
  });

  it.runIf(process.platform === "darwin")(
    "injects the process.title guard so a freehand `npm run build` via bash can't SIGSEGV",
    () => {
      // Stripping __CFBundleIdentifier isn't enough — the app-bundle responsibility
      // survives as a posix_spawn attribute. The bash / process_* paths run npm/vite
      // directly, so buildSanitizedEnv must carry the same NODE_OPTIONS guard the
      // managed build spawns get via hardenChildEnv.
      expect(buildSanitizedEnv().NODE_OPTIONS).toMatch(/--require .*no-process-title\.cjs/);
    },
  );

  it.skipIf(process.platform === "darwin")("does not inject the guard off macOS", () => {
    expect(buildSanitizedEnv().NODE_OPTIONS ?? "").not.toMatch(/no-process-title\.cjs/);
  });
});

describe("withNodeTitleGuard — process.title SIGSEGV guard (macOS)", () => {
  const isMac = process.platform === "darwin";

  it.runIf(isMac)("injects a --require preload via NODE_OPTIONS on macOS", () => {
    const env = withNodeTitleGuard({});
    expect(env.NODE_OPTIONS).toMatch(/--require .*no-process-title\.cjs/);
  });

  it.runIf(isMac)("appends to an existing NODE_OPTIONS without clobbering it", () => {
    const env = withNodeTitleGuard({ NODE_OPTIONS: "--max-old-space-size=2048" });
    expect(env.NODE_OPTIONS).toContain("--max-old-space-size=2048");
    expect(env.NODE_OPTIONS).toMatch(/--require .*no-process-title\.cjs/);
  });

  it.runIf(isMac)("is idempotent — a second pass does not double-add the flag", () => {
    const once = withNodeTitleGuard({});
    const twice = withNodeTitleGuard(once);
    expect(twice.NODE_OPTIONS).toBe(once.NODE_OPTIONS);
  });

  it.skipIf(isMac)("is a no-op off macOS", () => {
    const env = withNodeTitleGuard({ FOO: "bar" });
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it.runIf(isMac)("hardenChildEnv both strips contamination and guards process.title", () => {
    const env = hardenChildEnv({ __CFBundleIdentifier: "com.localagentx.desktop", KEEP: "1" });
    expect(env.__CFBundleIdentifier).toBeUndefined();
    expect(env.KEEP).toBe("1");
    expect(env.NODE_OPTIONS).toMatch(/no-process-title\.cjs/);
  });
});

describe("buildSanitizedEnv NODE_PATH for bundled deps", () => {
  it("points NODE_PATH at a real bundled node_modules containing pptxgenjs", () => {
    const env = buildSanitizedEnv();
    expect(env.NODE_PATH).toBeTruthy();
    const dirs = env.NODE_PATH!.split(delimiter);
    const bundled = dirs.find((d) => existsSync(join(d, "pptxgenjs")));
    expect(bundled).toBeTruthy();
  });

  it("appends bundled node_modules after an inherited NODE_PATH instead of clobbering it", () => {
    setEnv("NODE_PATH", "/some/inherited/path");
    const env = buildSanitizedEnv();
    const dirs = env.NODE_PATH!.split(delimiter);
    expect(dirs[0]).toBe("/some/inherited/path");
    expect(dirs.length).toBeGreaterThan(1);
  });
});

// Regression for the broken compiled-language (Rust) builds: a Finder-launched
// app inherits a minimal PATH without Homebrew/cargo, so `cargo: command not
// found` and the toolchain never runs. The repair appends existing standard
// toolchain dirs so the binary is reachable however LAX was launched.
describe("mergePathDirs — toolchain PATH repair", () => {
  const P = (...d: string[]) => d.join(delimiter);

  it("appends a missing dir AFTER the existing ones (system tools keep priority)", () => {
    const out = mergePathDirs(P("/usr/bin", "/bin"), ["/opt/homebrew/bin"]);
    expect(out).toBe(P("/usr/bin", "/bin", "/opt/homebrew/bin"));
    const parts = out.split(delimiter);
    expect(parts.indexOf("/usr/bin")).toBeLessThan(parts.indexOf("/opt/homebrew/bin"));
  });

  it("does not duplicate a dir already on PATH", () => {
    expect(mergePathDirs(P("/usr/bin", "/opt/homebrew/bin"), ["/opt/homebrew/bin", "/usr/bin"]))
      .toBe(P("/usr/bin", "/opt/homebrew/bin"));
  });

  it("handles an empty or undefined PATH", () => {
    expect(mergePathDirs("", ["/opt/homebrew/bin"])).toBe("/opt/homebrew/bin");
    expect(mergePathDirs(undefined, ["/x", "/y"])).toBe(P("/x", "/y"));
  });

  it("buildSanitizedEnv never drops an inherited PATH entry", () => {
    setEnv("PATH", P("/usr/bin", "/bin", "/sbin"));
    const env = buildSanitizedEnv();
    for (const d of ["/usr/bin", "/bin", "/sbin"]) expect(env.PATH!.split(delimiter)).toContain(d);
  });
});
