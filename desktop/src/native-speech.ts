// Native speech recognition bridge — owns the lifecycle of the per-OS
// helper binary (LaxSpeech.app on macOS, lax-speech-win.exe on Windows)
// and forwards transcript events back to the renderer over IPC.
//
// Why a separate process: SFSpeechRecognizer (macOS) + System.Speech
// (Windows) are native APIs the Chromium renderer can't reach. Electron's
// webkitSpeechRecognition only works in real Chrome/Edge (Google API key
// stripped from Electron's build) — this module replaces that one
// missing pipe for the Browser voice tier on desktop.
//
// Helper protocol (line-delimited JSON, see speech-helper.swift):
//   stdin  ← {"cmd":"start"} / {"cmd":"stop"} / {"cmd":"quit"}
//   stdout → {"type":"ready"|"result"|"error"|"stopped"|"auth", ...}
//
// We hold one helper per Electron process, started lazily on first start()
// and kept alive across start/stop cycles so the recognizer warms up once.

import { ChildProcess, spawn } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { app, BrowserWindow } from "electron";

type TranscriptEvent = { type: "result"; text: string; isFinal: boolean };
type HelperEvent =
  | { type: "ready" }
  | { type: "stopped" }
  | TranscriptEvent
  | { type: "error"; code: string; message: string }
  | { type: "auth"; status: string };

let helper: ChildProcess | null = null;
let helperReady = false;
let pendingStart = false;
let stdoutBuffer = "";

function resolveHelperPath(): string | null {
  // Packaged: electron-builder copies extraResources into
  // <App.app>/Contents/Resources/ on macOS, or <install-dir>/resources/
  // on Windows. process.resourcesPath points at that directory in both.
  //
  // Dev: helpers built into desktop/native/dist-bin/ by the prebuild
  // script. app.isPackaged distinguishes the two reliably.
  const baseDir = app.isPackaged
    ? process.resourcesPath
    : join(__dirname, "..", "native", "dist-bin");

  if (process.platform === "darwin") {
    const macPath = join(baseDir, "LaxSpeech.app", "Contents", "MacOS", "lax-speech-mac");
    return existsSync(macPath) ? macPath : null;
  }
  if (process.platform === "win32") {
    const winPath = join(baseDir, "lax-speech-win.exe");
    return existsSync(winPath) ? winPath : null;
  }
  // Linux: no native API analogue. Renderer falls back to the existing
  // "this tier doesn't work in Electron" alert path.
  return null;
}

export function isNativeSpeechAvailable(): boolean {
  return resolveHelperPath() != null;
}

function emitToRenderer(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try { win.webContents.send(channel, payload); } catch { /* renderer torn down */ }
    }
  }
}

function handleHelperLine(line: string): void {
  let event: HelperEvent;
  try { event = JSON.parse(line); } catch {
    console.warn(`[native-speech] non-JSON line from helper: ${line.slice(0, 200)}`);
    return;
  }
  switch (event.type) {
    case "ready":
      helperReady = true;
      if (pendingStart) {
        pendingStart = false;
        sendCommand({ cmd: "start" });
      }
      break;
    case "result":
      emitToRenderer("native-speech-event", event);
      break;
    case "error":
      console.warn(`[native-speech] helper error: ${event.code} — ${event.message}`);
      emitToRenderer("native-speech-event", event);
      break;
    case "auth":
      // macOS only — user denied Speech Recognition in TCC, or it's not
      // yet determined. Tell the renderer so it can surface a clear path
      // back ("Open System Settings → Privacy → Speech Recognition").
      console.warn(`[native-speech] auth status: ${event.status}`);
      emitToRenderer("native-speech-event", event);
      break;
    case "stopped":
      // Informational — renderer doesn't need to act on it.
      break;
  }
}

function spawnHelper(): void {
  if (helper) return;
  const path = resolveHelperPath();
  if (!path) {
    console.warn(`[native-speech] no helper for platform=${process.platform}`);
    return;
  }
  console.log(`[native-speech] spawning ${path}`);
  helper = spawn(path, [], { stdio: ["pipe", "pipe", "pipe"] });

  helper.stdout?.setEncoding("utf-8");
  helper.stdout?.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    // Newline-delimited JSON — flush each complete line as we get it.
    let nl = stdoutBuffer.indexOf("\n");
    while (nl !== -1) {
      const line = stdoutBuffer.slice(0, nl).trim();
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      if (line) handleHelperLine(line);
      nl = stdoutBuffer.indexOf("\n");
    }
  });

  helper.stderr?.setEncoding("utf-8");
  helper.stderr?.on("data", (chunk: string) => {
    // Helper isn't supposed to write to stderr — anything here is a
    // crash trail. Log so we can see it in the desktop console.
    console.warn(`[native-speech] helper stderr: ${chunk.trim()}`);
  });

  helper.on("exit", (code, signal) => {
    console.log(`[native-speech] helper exited code=${code} signal=${signal}`);
    helper = null;
    helperReady = false;
    pendingStart = false;
    stdoutBuffer = "";
    if (code !== 0 && code !== null) {
      emitToRenderer("native-speech-event", {
        type: "error",
        code: "helper_exited",
        message: `Native speech helper exited unexpectedly (code ${code})`,
      });
    }
  });
}

function sendCommand(cmd: Record<string, unknown>): void {
  if (!helper || !helper.stdin || helper.stdin.destroyed) return;
  helper.stdin.write(JSON.stringify(cmd) + "\n");
}

export function startNativeSpeech(): void {
  if (!helper) {
    spawnHelper();
    if (!helper) return; // unsupported platform / missing binary
  }
  if (helperReady) {
    sendCommand({ cmd: "start" });
  } else {
    // Helper still booting (TCC auth round-trip on macOS can take a
    // moment the first time). Defer until "ready" arrives.
    pendingStart = true;
  }
}

export function stopNativeSpeech(): void {
  if (!helper || !helperReady) {
    pendingStart = false;
    return;
  }
  sendCommand({ cmd: "stop" });
}

export function shutdownNativeSpeech(): void {
  if (!helper) return;
  try { sendCommand({ cmd: "quit" }); } catch { /* pipe closed */ }
  // Give the helper a beat to flush, then force-kill if it's still up.
  const h = helper;
  setTimeout(() => {
    if (h && !h.killed) {
      try { h.kill("SIGTERM"); } catch { /* already gone */ }
    }
  }, 500);
}
