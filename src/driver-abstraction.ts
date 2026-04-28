import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";

export interface Driver {
  init(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  isAvailable(): boolean;
}

export type DriverType =
  | "camera"
  | "microphone"
  | "speaker"
  | "display"
  | "sensor";

export interface CameraDriver extends Driver {
  captureFrame(): Promise<Buffer>;
  setResolution(width: number, height: number): void;
}

export interface MicrophoneDriver extends Driver {
  startRecording(): void;
  stopRecording(): Buffer;
  onAudio(handler: (chunk: Buffer) => void): void;
}

export interface SpeakerDriver extends Driver {
  play(audio: Buffer, format?: string): Promise<void>;
  setVolume(level: number): void;
}

export interface DisplayDriver extends Driver {
  render(content: Buffer, format: string): Promise<void>;
  clear(): void;
  getResolution(): { width: number; height: number };
}

export interface SensorDriver extends Driver {
  read(): Promise<Record<string, number>>;
  getSensorType(): string;
}

function runCommand(
  cmd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "buffer" }, (err, stdout, stderr) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
      });
    });
  });
}

function runCommandRaw(
  cmd: string,
  args: string[]
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "buffer", maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

export class WebcamDriver implements CameraDriver {
  private available = false;
  private width = 1280;
  private height = 720;
  private device: string;

  constructor(device = "/dev/video0") {
    this.device = device;
  }

  async init(): Promise<void> {
    try {
      await runCommand("ffmpeg", ["-version"]);
      this.available = true;
    } catch {
      this.available = false;
    }
  }

  async start(): Promise<void> {
    if (!this.available) throw new Error("Webcam driver not available");
  }

  async stop(): Promise<void> {
    // stateless capture, nothing to stop
  }

  isAvailable(): boolean {
    return this.available;
  }

  async captureFrame(): Promise<Buffer> {
    const args = [
      "-f", process.platform === "win32" ? "dshow" : "v4l2",
      "-i", this.device,
      "-frames:v", "1",
      "-s", `${this.width}x${this.height}`,
      "-f", "rawvideo",
      "-pix_fmt", "rgb24",
      "pipe:1",
    ];
    return runCommandRaw("ffmpeg", args);
  }

  setResolution(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }
}

export class SystemMicDriver extends EventEmitter implements MicrophoneDriver {
  private available = false;
  private recording = false;
  private chunks: Buffer[] = [];

  async init(): Promise<void> {
    try {
      if (process.platform === "win32") {
        await runCommand("powershell", [
          "-Command",
          "Get-CimInstance Win32_SoundDevice | Select-Object -First 1",
        ]);
      } else {
        await runCommand("arecord", ["--list-devices"]);
      }
      this.available = true;
    } catch {
      this.available = false;
    }
  }

  async start(): Promise<void> {
    if (!this.available) throw new Error("Microphone driver not available");
  }

  async stop(): Promise<void> {
    this.recording = false;
    this.chunks = [];
  }

  isAvailable(): boolean {
    return this.available;
  }

  startRecording(): void {
    this.recording = true;
    this.chunks = [];
  }

  stopRecording(): Buffer {
    this.recording = false;
    const combined = Buffer.concat(this.chunks);
    this.chunks = [];
    return combined;
  }

  onAudio(handler: (chunk: Buffer) => void): void {
    this.on("audio-chunk", handler);
  }

  pushChunk(chunk: Buffer): void {
    if (!this.recording) return;
    this.chunks.push(chunk);
    this.emit("audio-chunk", chunk);
  }
}

export class SystemSpeakerDriver implements SpeakerDriver {
  private available = false;
  private volume = 80;

  async init(): Promise<void> {
    try {
      if (process.platform === "win32") {
        await runCommand("powershell", [
          "-Command",
          "Get-CimInstance Win32_SoundDevice | Select-Object -First 1",
        ]);
      } else {
        await runCommand("aplay", ["--list-devices"]);
      }
      this.available = true;
    } catch {
      this.available = false;
    }
  }

  async start(): Promise<void> {
    if (!this.available) throw new Error("Speaker driver not available");
  }

  async stop(): Promise<void> {
    // nothing to tear down
  }

  isAvailable(): boolean {
    return this.available;
  }

  async play(audio: Buffer, format = "wav"): Promise<void> {
    if (!/^[a-z0-9]{1,10}$/.test(format)) throw new Error(`Invalid audio format: ${format}`);
    const os = await import("node:os");
    const path = await import("node:path");
    const crypto = await import("node:crypto");
    const tmpDir = await import("node:fs/promises").then(f => f.mkdtemp(path.join(os.tmpdir(), "lax-play-")));
    const tmpFile = path.join(tmpDir, `playback.${format}`);
    const fs = await import("node:fs/promises");
    await fs.writeFile(tmpFile, audio, { mode: 0o600 });
    try {
      if (process.platform === "win32") {
        await runCommand("powershell", [
          "-Command",
          `(New-Object Media.SoundPlayer '${tmpFile.replace(/'/g, "''")}').PlaySync()`,
        ]);
      } else if (process.platform === "darwin") {
        await runCommand("afplay", ["-v", String(this.volume / 100), tmpFile]);
      } else {
        await runCommand("aplay", [tmpFile]);
      }
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
      await fs.rmdir(tmpDir).catch(() => {});
    }
  }

  setVolume(level: number): void {
    this.volume = Math.max(0, Math.min(100, level));
  }
}

export class DriverRegistry {
  private drivers = new Map<DriverType, Driver>();

  registerDriver(type: DriverType, driver: Driver): void {
    this.drivers.set(type, driver);
  }

  getDriver<T extends Driver>(type: DriverType): T | undefined {
    return this.drivers.get(type) as T | undefined;
  }

  listDrivers(): Array<{ type: DriverType; available: boolean }> {
    const result: Array<{ type: DriverType; available: boolean }> = [];
    const entries = Array.from(this.drivers.entries());
    for (const [type, driver] of entries) {
      result.push({ type, available: driver.isAvailable() });
    }
    return result;
  }

  async initAll(): Promise<void> {
    const drivers = Array.from(this.drivers.values());
    for (const driver of drivers) {
      await driver.init();
    }
  }

  async stopAll(): Promise<void> {
    const drivers = Array.from(this.drivers.values());
    for (const driver of drivers) {
      await driver.stop();
    }
  }
}
