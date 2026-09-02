import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Canonicalize the temp root BEFORE anything mints a temp dir. macOS hands
// every process a symlinked TMPDIR (/var/folders/… → /private/var/folders/…),
// so fixtures that build roots via mkdtempSync(join(tmpdir(), …)) and then
// compare against product output that canonicalizes paths (realpathSync) fail
// with "/var vs /private/var" — and fail-closed "linked ancestor" guards
// (installer data-root, plugin-system) reject the root outright. os.tmpdir()
// re-reads the env on every call, so realpathing it here — the shared vitest
// setup file, which runs before each test file — is the ONE seam that gives
// every fixture (and every child process that inherits the env) a canonical,
// symlink-free temp root. Windows spells the variable TMP/TEMP; set all three.
try {
  const canonicalTmp = realpathSync(tmpdir());
  process.env.TMPDIR = canonicalTmp;
  process.env.TMP = canonicalTmp;
  process.env.TEMP = canonicalTmp;
} catch {
  // tmpdir unresolvable — leave the env alone; the failing fixture will say so.
}

// Per-file test isolation. Runs before each test file (vitest setupFiles).
//
// Point HOME/USERPROFILE at a throwaway dir so getLaxDir() resolves to a
// clean <home>/.lax that this file owns — same isolation the auth tests do
// by hand. Seed settings.json with a model so canonical-loop model
// resolution (getSetting("model")) is deterministic: pointed at the real
// ~/.lax these tests passed only on a developer machine that happened to
// have a model configured, and failed on a clean CI runner. Never touches
// the developer's real ~/.lax. Tests that set their own HOME / LAX_DATA_DIR
// override this.
const home = mkdtempSync(join(tmpdir(), "lax-home-"));
const laxDir = join(home, ".lax");
mkdirSync(laxDir, { recursive: true });
writeFileSync(join(laxDir, "settings.json"), JSON.stringify({ model: "claude-sonnet-4-6" }), "utf-8");
process.env.HOME = home;
process.env.USERPROFILE = home;
// Never route a test's safe-delete into the developer's real OS Trash — force
// the ~/.lax fallback so trash assertions are deterministic and self-contained.
process.env.LAX_NO_NATIVE_TRASH = "1";

afterAll(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
