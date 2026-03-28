/**
 * Demo Recording Module
 *
 * Records full agent sessions as replayable JSON files
 * and exports markdown transcripts for documentation.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export type RecordingEventType =
  | "user_message"
  | "assistant_response"
  | "tool_call"
  | "tool_result"
  | "error"
  | "voice_start"
  | "voice_end"
  | "voice_transcript"
  | "system";

export interface RecordingEvent {
  timestamp: number;
  type: RecordingEventType;
  data: Record<string, unknown>;
}

export interface Recording {
  id: string;
  sessionId: string;
  startedAt: string;
  duration: number;
  metadata: Record<string, unknown>;
  events: RecordingEvent[];
}

const RECORDINGS_DIR = join(homedir(), ".sax", "recordings");

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export class DemoRecorder {
  private recording: Recording | null = null;
  private startTime = 0;
  private active = false;

  startRecording(sessionId: string, metadata?: Record<string, unknown>): Recording {
    this.startTime = Date.now();
    this.active = true;
    this.recording = {
      id: randomUUID(),
      sessionId,
      startedAt: new Date(this.startTime).toISOString(),
      duration: 0,
      metadata: metadata ?? {},
      events: [],
    };
    this.addEvent({
      timestamp: 0,
      type: "system",
      data: { action: "recording_started", sessionId },
    });
    return this.recording;
  }

  stopRecording(): Recording | null {
    if (!this.recording || !this.active) {
      return null;
    }
    this.active = false;
    this.recording.duration = Date.now() - this.startTime;
    this.addEvent({
      timestamp: this.recording.duration,
      type: "system",
      data: { action: "recording_stopped" },
    });
    return this.recording;
  }

  addEvent(event: RecordingEvent): void {
    if (!this.recording) {
      return;
    }
    const entry: RecordingEvent = {
      timestamp: event.timestamp ?? (Date.now() - this.startTime),
      type: event.type,
      data: event.data,
    };
    this.recording.events.push(entry);
  }

  recordUserMessage(content: string): void {
    this.addEvent({
      timestamp: Date.now() - this.startTime,
      type: "user_message",
      data: { content },
    });
  }

  recordAssistantResponse(content: string, durationMs?: number): void {
    this.addEvent({
      timestamp: Date.now() - this.startTime,
      type: "assistant_response",
      data: { content, durationMs: durationMs ?? 0 },
    });
  }

  recordToolCall(name: string, args: Record<string, unknown>, result: unknown, durationMs: number): void {
    this.addEvent({
      timestamp: Date.now() - this.startTime,
      type: "tool_call",
      data: { name, args, result, durationMs },
    });
  }

  recordError(error: string, context?: Record<string, unknown>): void {
    this.addEvent({
      timestamp: Date.now() - this.startTime,
      type: "error",
      data: { error, ...context },
    });
  }

  recordVoiceEvent(action: "start" | "end" | "transcript", detail?: Record<string, unknown>): void {
    const typeMap: Record<string, RecordingEventType> = {
      start: "voice_start",
      end: "voice_end",
      transcript: "voice_transcript",
    };
    this.addEvent({
      timestamp: Date.now() - this.startTime,
      type: typeMap[action],
      data: detail ?? {},
    });
  }

  getRecording(): Recording | null {
    if (!this.recording) {
      return null;
    }
    return { ...this.recording, events: [...this.recording.events] };
  }

  isActive(): boolean {
    return this.active;
  }

  saveRecording(path?: string): string {
    if (!this.recording) {
      throw new Error("No active recording to save");
    }
    const target = path ?? join(RECORDINGS_DIR, `${this.recording.id}.json`);
    const dir = target.substring(0, target.lastIndexOf("/") !== -1 ? target.lastIndexOf("/") : target.lastIndexOf("\\"));
    ensureDir(dir);
    writeFileSync(target, JSON.stringify(this.recording, null, 2), "utf-8");
    return target;
  }

  static loadRecording(path: string): Recording {
    if (!existsSync(path)) {
      throw new Error(`Recording not found: ${path}`);
    }
    return JSON.parse(readFileSync(path, "utf-8")) as Recording;
  }

  static listRecordings(): string[] {
    ensureDir(RECORDINGS_DIR);
    return readdirSync(RECORDINGS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => join(RECORDINGS_DIR, f));
  }

  toMarkdown(): string {
    if (!this.recording) {
      return "";
    }
    const rec = this.recording;
    const lines: string[] = [];
    lines.push(`# Session Recording: ${rec.sessionId}`);
    lines.push("");
    lines.push(`**Date:** ${rec.startedAt}`);
    lines.push(`**Duration:** ${formatDuration(rec.duration)}`);
    if (Object.keys(rec.metadata).length > 0) {
      lines.push(`**Metadata:** ${JSON.stringify(rec.metadata)}`);
    }
    lines.push("");
    lines.push("---");
    lines.push("");

    for (const event of rec.events) {
      const ts = formatTimestamp(event.timestamp);

      switch (event.type) {
        case "user_message":
          lines.push(`**[${ts}] User:**`);
          lines.push(String(event.data.content));
          lines.push("");
          break;

        case "assistant_response":
          lines.push(`**[${ts}] Assistant:**`);
          lines.push(String(event.data.content));
          if (event.data.durationMs) {
            lines.push(`*Response time: ${Number(event.data.durationMs)}ms*`);
          }
          lines.push("");
          break;

        case "tool_call":
          lines.push(`**[${ts}] Tool: ${event.data.name}**`);
          lines.push(`\`\`\`json`);
          lines.push(JSON.stringify(event.data.args, null, 2));
          lines.push(`\`\`\``);
          if (event.data.durationMs) {
            lines.push(`*Execution time: ${Number(event.data.durationMs)}ms*`);
          }
          lines.push("");
          break;

        case "error":
          lines.push(`**[${ts}] Error:** ${event.data.error}`);
          lines.push("");
          break;

        case "voice_start":
          lines.push(`**[${ts}] Voice input started**`);
          lines.push("");
          break;

        case "voice_end":
          lines.push(`**[${ts}] Voice input ended**`);
          lines.push("");
          break;

        case "voice_transcript":
          lines.push(`**[${ts}] Voice transcript:** ${event.data.text ?? ""}`);
          lines.push("");
          break;

        case "system":
          lines.push(`*[${ts}] ${event.data.action}*`);
          lines.push("");
          break;
      }
    }

    return lines.join("\n");
  }
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = ms % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
