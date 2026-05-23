import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readBodyBytes } from "./sidecar-proxy.js";

// Body: {name, sourceUrl?, sourceFile?, epochsSovits?, epochsGpt?}. The
// Python orchestrator emits stdout lines we relay verbatim as SSE — see
// python/sovits/train_pipeline.py for the protocol. ~30-45 min wall time
// on a 3060 for a 30 min source.
export async function handleTrainingStart(
  req: any,
  res: any,
  json: (status: number, data: unknown) => void,
): Promise<void> {
  let body: any;
  try {
    const buf = await readBodyBytes(req);
    body = JSON.parse(buf.toString("utf-8"));
  } catch (e) {
    json(400, { error: `bad request body: ${(e as Error).message}` });
    return;
  }
  if (!body.name) {
    json(400, { error: "name required" });
    return;
  }
  if (!body.resumeExpName && !body.sourceUrl && !body.sourceFile) {
    json(400, { error: "resumeExpName, sourceUrl, or sourceFile required" });
    return;
  }
  const venvPython = join(homedir(), "miniconda3", "envs", "GPTSoVits", "python.exe");
  // Use process.cwd() so this works regardless of project folder name —
  // hardcoding the slug ('secret-agent-x') broke when the folder was
  // renamed to Local-Agent-X (May 2026).
  const script = join(process.cwd(), "python", "sovits", "train_pipeline.py");
  if (!existsSync(venvPython)) {
    json(503, { error: "GPT-SoVITS conda env not installed", hint: `expected ${venvPython}` });
    return;
  }
  if (!existsSync(script)) {
    json(503, { error: "training pipeline script missing", hint: script });
    return;
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
  // Detach the child so a Node restart (deploy, crash, manual kill) does
  // NOT take it down via the Windows job-object inheritance. Without this
  // any restart of the LAX server kills any in-flight training, which is
  // brutal when training takes 30-45 min. The orchestrator writes its
  // progress to <workdir>/_pipeline.log so the modal can re-attach via
  // GET /training/<exp>/log on the next page load.
  const child = spawn(venvPython, args, {
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
    detached: true,
    windowsHide: true,
  });
  child.unref();
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
}
