import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export async function handleTrainingLog(
  url: URL,
  json: (status: number, data: unknown) => void,
): Promise<void> {
  const expName = decodeURIComponent(url.pathname.split("/")[5]);
  if (!expName.match(/^voice_[a-f0-9]{8,}$/i)) {
    json(400, { error: "invalid exp_name" });
    return;
  }
  const logPath = join(homedir(), ".lax", "sovits-training", "datasets", expName, "_pipeline.log");
  if (!existsSync(logPath)) {
    json(200, { content: "", size: 0, missing: true });
    return;
  }
  try {
    const { statSync, openSync, readSync, closeSync } = await import("node:fs");
    const stats = statSync(logPath);
    const since = Math.max(0, Number(url.searchParams.get("since") || "0"));
    let content = "";
    if (since < stats.size) {
      if (since === 0) {
        // Tail the last 64KB to avoid shipping an enormous initial payload.
        const TAIL = 65536;
        const start = Math.max(0, stats.size - TAIL);
        const fd = openSync(logPath, "r");
        try {
          const buf = Buffer.alloc(stats.size - start);
          readSync(fd, buf, 0, buf.length, start);
          content = buf.toString("utf-8");
          // If we tail-cut, drop the partial first line so we don't render
          // a half-line at the top of the viewer.
          if (start > 0) {
            const nl = content.indexOf("\n");
            if (nl > 0) content = content.slice(nl + 1);
          }
        } finally { closeSync(fd); }
      } else {
        const fd = openSync(logPath, "r");
        try {
          const buf = Buffer.alloc(stats.size - since);
          readSync(fd, buf, 0, buf.length, since);
          content = buf.toString("utf-8");
        } finally { closeSync(fd); }
      }
    }
    json(200, { content, size: stats.size });
  } catch (e) {
    json(500, { error: (e as Error).message });
  }
}
