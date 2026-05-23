import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export async function handleTrainingDelete(
  url: URL,
  json: (status: number, data: unknown) => void,
): Promise<void> {
  const expName = decodeURIComponent(url.pathname.replace("/api/voices/sovits/training/", ""));
  if (!expName.match(/^voice_[a-f0-9]{8,}$/i)) {
    json(400, { error: "invalid exp_name" });
    return;
  }
  const trainingRoot = join(homedir(), ".lax", "sovits-training", "datasets");
  const sovitsRepo = join(homedir(), ".lax", "sovits", "repo");
  try {
    const { rmSync, readdirSync } = await import("node:fs");
    const targets = [
      join(trainingRoot, expName),
      join(sovitsRepo, "logs", expName),
      join(sovitsRepo, "TEMP", `tmp_s2_${expName}.json`),
      join(sovitsRepo, "TEMP", `tmp_s1_${expName}.yaml`),
    ];
    const removed: string[] = [];
    for (const t of targets) {
      if (existsSync(t)) {
        rmSync(t, { recursive: true, force: true });
        removed.push(t);
      }
    }
    // Per-epoch weight files match a prefix
    for (const dir of [join(sovitsRepo, "SoVITS_weights_v2Pro"),
                       join(sovitsRepo, "GPT_weights_v2Pro")]) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (f.startsWith(expName + "_e") || f.startsWith(expName + "-e")) {
          const full = join(dir, f);
          rmSync(full, { force: true });
          removed.push(full);
        }
      }
    }
    json(200, { ok: true, removed });
  } catch (e) {
    json(500, { error: (e as Error).message });
  }
}
