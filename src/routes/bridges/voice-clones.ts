import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RouteHandler } from "../../server-context.js";
import { jsonResponse } from "../../server-utils.js";

const CB_BASE = () => `http://127.0.0.1:${process.env.LAX_CHATTERBOX_PORT || "7010"}`;
const SV_BASE = () => `http://127.0.0.1:${process.env.LAX_SOVITS_PORT || "7012"}`;
const MAX_BODY = 25 * 1024 * 1024;

async function readBodyBytes(req: any): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY) throw new Error("Payload too large (max 25MB)");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function probeSidecar(base: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) return await r.json() as Record<string, unknown>;
  } catch { /* sidecar down */ }
  return null;
}

async function proxyToSidecar(
  base: string, path: string, method: string, req: any,
): Promise<{ status: number; body: unknown }> {
  const opts: RequestInit = { method, signal: AbortSignal.timeout(120_000) };
  if (method === "POST" || method === "PATCH") {
    opts.body = await readBodyBytes(req);
    opts.headers = { "Content-Type": "application/json" };
  }
  const r = await fetch(`${base}${path}`, opts);
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

export const handleVoiceCloneRoutes: RouteHandler = async (method, url, req, res, _ctx, _role) => {
  const json = (status: number, data: unknown) => jsonResponse(res, status, data, req);

  // ── /api/voices/tier — capability probe; reports both Chatterbox + SoVITS ──
  // SoVITS is preferred when available (supports trained voices); Chatterbox
  // remains as zero-shot fallback.
  if (method === "GET" && url.pathname === "/api/voices/tier") {
    const [cb, sv] = await Promise.all([probeSidecar(CB_BASE()), probeSidecar(SV_BASE())]);
    json(200, {
      tier: sv?.ready ? "studio-trained" : (cb?.ready ? "studio" : "lite"),
      chatterbox: cb ? { ready: !!cb.ready, ...cb } : { ready: false },
      sovits: sv ? { ready: !!sv.ready, ...sv } : { ready: false },
    });
    return true;
  }

  // ── /api/voices/chatterbox/* → Chatterbox sidecar (:7010) ──
  if (url.pathname === "/api/voices/chatterbox" || url.pathname.startsWith("/api/voices/chatterbox/")) {
    const sidecarPath = url.pathname.replace("/api/voices/chatterbox", "/clones");
    try {
      const { status, body } = await proxyToSidecar(CB_BASE(), sidecarPath, method, req);
      json(status, body);
      return true;
    } catch (e) {
      if ((e as Error).message?.includes("Payload too large")) {
        json(413, { error: (e as Error).message });
        req.destroy();
        return true;
      }
      json(503, {
        error: "Chatterbox sidecar unreachable",
        detail: (e as Error).message,
        hint: "Run python/chatterbox/install.ps1 to install the Studio tier",
      });
      return true;
    }
  }

  // ── /api/voices/sovits/training/list — list in-progress (incomplete) runs.
  // Walks ~/.lax/sovits-training/datasets/ and returns runs that have a
  // workdir but no corresponding registered clone. Each entry includes the
  // furthest-completed stage so the UI can show "Resume from format step"
  // type guidance.
  if (method === "GET" && url.pathname === "/api/voices/sovits/training/list") {
    const trainingRoot = join(homedir(), ".lax", "sovits-training", "datasets");
    const sovitsRepo = join(homedir(), ".lax", "sovits", "repo");
    if (!existsSync(trainingRoot)) { json(200, { runs: [] }); return true; }
    try {
      const { readdirSync, statSync } = await import("node:fs");
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
        let mtime = 0;
        try { mtime = Math.floor(statSync(wd).mtimeMs); } catch { /* */ }
        return { name, stage, mtimeMs: mtime, hasFormat, hasSovits, hasGpt };
      });
      // Filter to incomplete runs only (no fully-trained clone yet).
      const incomplete = runs.filter(r => !(r.hasSovits && r.hasGpt && r.stage === "register" /*= done*/))
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      json(200, { runs: incomplete });
      return true;
    } catch (e) {
      json(500, { error: (e as Error).message });
      return true;
    }
  }

  // ── DELETE /api/voices/sovits/training/<exp_name> — purge a stale or
  // abandoned training run. Removes the dataset workdir, logs dir, partial
  // weights, and temp configs. Frees disk + clears the modal's resume list.
  if (method === "DELETE" && url.pathname.startsWith("/api/voices/sovits/training/")) {
    const expName = decodeURIComponent(url.pathname.replace("/api/voices/sovits/training/", ""));
    if (!expName.match(/^voice_[a-f0-9]{8,}$/i)) {
      json(400, { error: "invalid exp_name" });
      return true;
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
      return true;
    } catch (e) {
      json(500, { error: (e as Error).message });
      return true;
    }
  }

  // ── /api/voices/sovits/train — kick off the end-to-end training pipeline
  // (SSE stream of progress events). Body: {name, sourceUrl?, sourceFile?,
  // epochsSovits?, epochsGpt?}. The Python orchestrator emits stdout lines
  // we relay verbatim as SSE — see python/sovits/train_pipeline.py for the
  // protocol. ~30-45 min wall time on a 3060 for a 30 min source.
  if (method === "POST" && url.pathname === "/api/voices/sovits/train") {
    let body: any;
    try {
      const buf = await readBodyBytes(req);
      body = JSON.parse(buf.toString("utf-8"));
    } catch (e) {
      json(400, { error: `bad request body: ${(e as Error).message}` });
      return true;
    }
    if (!body.name) {
      json(400, { error: "name required" });
      return true;
    }
    if (!body.resumeExpName && !body.sourceUrl && !body.sourceFile) {
      json(400, { error: "resumeExpName, sourceUrl, or sourceFile required" });
      return true;
    }
    const venvPython = join(homedir(), "miniconda3", "envs", "GPTSoVits", "python.exe");
    const script = join(homedir(), "secret-agent-x", "python", "sovits", "train_pipeline.py");
    if (!existsSync(venvPython)) {
      json(503, { error: "GPT-SoVITS conda env not installed", hint: `expected ${venvPython}` });
      return true;
    }
    if (!existsSync(script)) {
      json(503, { error: "training pipeline script missing", hint: script });
      return true;
    }
    const args = [
      "-u", script,
      "--name", String(body.name),
      "--epochs-sovits", String(body.epochsSovits || 8),
      "--epochs-gpt", String(body.epochsGpt || 15),
    ];
    if (body.sourceUrl) args.push("--source-url", String(body.sourceUrl));
    if (body.sourceFile) args.push("--source-file", String(body.sourceFile));
    if (body.denoise) args.push("--denoise");
    if (body.resumeExpName) args.push("--resume", String(body.resumeExpName));

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const sse = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    sse("started", { args });
    const child = spawn(venvPython, args, {
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
    });
    let stdoutBuf = "";
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf-8");
      let nl;
      while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, nl).replace(/\r$/, "");
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        const m = line.match(/^(STAGE|LOG|DONE|ERROR):\s*(.*)$/);
        if (!m) { sse("log", { line }); continue; }
        const [, kind, payload] = m;
        if (kind === "STAGE") {
          const [id, label, pct, eta] = payload.split("|");
          sse("stage", { id, label, pct: Number(pct), etaSec: Number(eta) || 0 });
        } else if (kind === "DONE") {
          try { sse("done", JSON.parse(payload)); } catch { sse("done", { raw: payload }); }
        } else if (kind === "ERROR") {
          sse("error", { message: payload });
        } else {
          sse("log", { line: payload });
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf-8").trim();
      if (text) sse("log", { line: text, stderr: true });
    });
    child.on("close", (code) => {
      sse("close", { code: code ?? -1 });
      res.end();
    });
    // Intentionally do NOT kill the child on req.close — training is a
    // 30-45 min job and the modal text promises "you can close this and
    // the training continues server-side". The child writes results to
    // disk and registers the clone via /clones POST; the user just won't
    // see live progress after closing. (If we wanted explicit cancel
    // we'd add a separate POST /api/voices/sovits/train/cancel route.)
    return true;
  }

  // ── /api/voices/sovits/* → SoVITS clones sidecar (:7012) ──
  // Same surface as Chatterbox so the chat picker can treat both uniformly.
  // Exposes /clones list + register, /clones/{id}/synth, etc.
  // (Listed AFTER /api/voices/sovits/train so the training route wins.)
  if (url.pathname === "/api/voices/sovits" || url.pathname.startsWith("/api/voices/sovits/")) {
    const sidecarPath = url.pathname.replace("/api/voices/sovits", "/clones");
    try {
      const { status, body } = await proxyToSidecar(SV_BASE(), sidecarPath, method, req);
      json(status, body);
      return true;
    } catch (e) {
      if ((e as Error).message?.includes("Payload too large")) {
        json(413, { error: (e as Error).message });
        req.destroy();
        return true;
      }
      json(503, {
        error: "SoVITS sidecar unreachable",
        detail: (e as Error).message,
        hint: "Run python/sovits/server.py (needs api_v2 at :7011 too)",
      });
      return true;
    }
  }

  return false;
};
