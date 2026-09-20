// A dead image URL must not cost the user the deck.
//
// from_outline threw away the whole presentation when every image source
// failed, to keep the promise that a tool "can never report success on a
// document the caller asked to illustrate". It kept that promise by destroying
// the artifact: a live 27B lost nine good slides to three 404s, rebuilt the
// identical outline imageless, and the user read the exchange as the model
// lying about a deck that did in fact exist (2026-09-19).
//
// The two jobs are separable. Write the deck; keep the result a FAILURE. Only
// "declined" means nothing landed (dispatch-tools.ts NEVER_LANDED), so an
// errored call is already understood to have possibly had side effects.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { presentationTools } from "../src/tools/presentation-tools.js";

const presentation = presentationTools[0];

const DEAD = "https://images.example.invalid/nope-404.jpg";

let dir: string;
let prevWorkspace: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lax-deck-"));
  prevWorkspace = process.env.LAX_WORKSPACE_DIR;
  process.env.LAX_WORKSPACE_DIR = dir;
});
afterEach(() => {
  if (prevWorkspace === undefined) delete process.env.LAX_WORKSPACE_DIR;
  else process.env.LAX_WORKSPACE_DIR = prevWorkspace;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const outline = "# Lions\n\n- Anatomy\n- Pride structure\n\n# Hunting\n\n- Ambush\n- Cooperation\n";

describe("from_outline when every image source is dead", () => {
  it("writes the deck anyway", async () => {
    const r = await presentation.execute({
      action: "from_outline",
      file_path: join(dir, "lions.pptx"),
      outline,
      images: [{ source: DEAD }],
    });
    expect(existsSync(join(dir, "lions.pptx"))).toBe(true);
    expect(statSync(join(dir, "lions.pptx")).size).toBeGreaterThan(0);
    expect(r.metadata?.file_path).toBeTruthy();
  });

  it("still reports FAILURE, so an illustrated deck cannot be claimed", async () => {
    const r = await presentation.execute({
      action: "from_outline",
      file_path: join(dir, "lions.pptx"),
      outline,
      images: [{ source: DEAD }],
    });
    expect(r.isError).toBe(true);
    expect(r.metadata?.image_count).toBe(0);
    expect(r.metadata?.images_requested).toBe(1);
  });

  it("names the file it wrote and says not to rebuild it", async () => {
    const r = await presentation.execute({
      action: "from_outline",
      file_path: join(dir, "lions.pptx"),
      outline,
      images: [{ source: DEAD }],
    });
    expect(r.content).toContain("lions.pptx");
    expect(r.content).toMatch(/WITHOUT images/i);
    expect(r.content).toMatch(/add_image_slide/);
    expect(r.content).toMatch(/[Dd]o not rebuild/);
    // The old text claimed the opposite and was the reason the deck was lost.
    expect(r.content).not.toMatch(/not written/i);
  });

  it("a deck that asked for no images is unaffected", async () => {
    const r = await presentation.execute({
      action: "from_outline",
      file_path: join(dir, "plain.pptx"),
      outline,
    });
    expect(r.isError).toBeFalsy();
    expect(existsSync(join(dir, "plain.pptx"))).toBe(true);
  });
});
