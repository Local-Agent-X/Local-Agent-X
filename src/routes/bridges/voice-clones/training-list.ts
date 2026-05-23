import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Walks ~/.lax/sovits-training/datasets/ and returns runs that have a
// workdir but no corresponding registered clone. Each entry includes the
// furthest-completed stage so the UI can show "Resume from format step"
// type guidance.
export async function handleTrainingList(
  json: (status: number, data: unknown) => void,
): Promise<void> {
  const trainingRoot = join(homedir(), ".lax", "sovits-training", "datasets");
  const sovitsRepo = join(homedir(), ".lax", "sovits", "repo");
  if (!existsSync(trainingRoot)) { json(200, { runs: [] }); return; }
  try {
    const { readdirSync, statSync, readFileSync } = await import("node:fs");
    const runs = readdirSync(trainingRoot).filter(n => n.startsWith("voice_")).map(name => {
      const wd = join(trainingRoot, name);
      const has = (rel: string) => existsSync(join(wd, rel));
      const logsDir = join(sovitsRepo, "logs", name);
      const hasLogs = existsSync(logsDir);
      const hasFormat = hasLogs && existsSync(join(logsDir, "2-name2text.txt"));
      const sovitsWeightsDir = join(sovitsRepo, "SoVITS_weights_v2Pro");
      const gptWeightsDir = join(sovitsRepo, "GPT_weights_v2Pro");
      const hasSovits = existsSync(sovitsWeightsDir) &&
        readdirSync(sovitsWeightsDir).some(f => f.startsWith(name + "_e"));
      const hasGpt = existsSync(gptWeightsDir) &&
        readdirSync(gptWeightsDir).some(f => f.startsWith(name + "-e"));
      const stage =
        hasGpt ? "register" :
        hasSovits ? "train_gpt" :
        hasFormat ? "train_sovits" :
        has("ref.wav") ? "format" :
        has("asr/sliced.list") ? "ref" :
        has("sliced") ? "asr" :
        has("source_clean.wav") || has("source.wav") ? "slice" :
        "download";
      // mtime: take the MAX across the workdir + the active log files,
      // because directory mtime only ticks when entries are created/deleted
      // (not when files inside are written). During GPT training the only
      // writes happen to logs/<exp>/train.log and the weights file, both
      // outside workdir, so the workdir-only stat would falsely age out.
      let mtime = 0;
      const tryStat = (p: string) => {
        try {
          if (!existsSync(p)) return;
          const m = Math.floor(statSync(p).mtimeMs);
          if (m > mtime) mtime = m;
        } catch { /* */ }
      };
      tryStat(wd);
      tryStat(join(wd, "_pipeline.log"));
      tryStat(join(logsDir, "train.log"));
      // Latest SoVITS / GPT weight files for this run (most recently
      // saved checkpoint timestamp) — covers both training stages.
      for (const dir of [join(sovitsRepo, "SoVITS_weights_v2Pro"),
                         join(sovitsRepo, "GPT_weights_v2Pro")]) {
        try {
          if (!existsSync(dir)) continue;
          for (const f of readdirSync(dir)) {
            if (f.startsWith(name + "_e") || f.startsWith(name + "-e")) {
              tryStat(join(dir, f));
            }
          }
        } catch { /* */ }
      }
      // Read the run's saved display name from _meta.json (written by the
      // pipeline on fresh start). Lets the modal show "Jarvis" instead of
      // "voice_d3534964" and lets Resume preserve the original name without
      // the user retyping it. Falls back to the exp_name when no meta.
      let displayName: string | null = null;
      const metaPath = join(wd, "_meta.json");
      if (existsSync(metaPath)) {
        try {
          const m = JSON.parse(readFileSync(metaPath, "utf-8"));
          if (typeof m.name === "string" && m.name.trim()) displayName = m.name.trim();
        } catch { /* */ }
      }
      return { name, displayName, stage, mtimeMs: mtime, hasFormat, hasSovits, hasGpt };
    });
    // Filter to incomplete runs only (no fully-trained clone yet).
    const incomplete = runs.filter(r => !(r.hasSovits && r.hasGpt && r.stage === "register" /*= done*/))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    json(200, { runs: incomplete });
  } catch (e) {
    json(500, { error: (e as Error).message });
  }
}
