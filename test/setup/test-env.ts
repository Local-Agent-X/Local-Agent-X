import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
