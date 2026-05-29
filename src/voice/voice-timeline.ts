/**
 * Voice Activity Timeline — logs all voice interactions with timestamps.
 * Provides a searchable, persistent record of voice activity.
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const TIMELINE_DIR = join(getLaxDir(), "voice-timeline");
if (!existsSync(TIMELINE_DIR)) mkdirSync(TIMELINE_DIR, { recursive: true });

export type VoiceEventType =
  | "stt_start"
  | "stt_end"
  | "tts_start"
  | "tts_end"
  | "wake_word"
  | "command"
  | "interrupt"
  | "error"
  | "speaker_identified"
  | "emotion_detected"
  | "silence"
  | "custom";

export interface VoiceEvent {
  timestamp: string;    // ISO 8601
  type: VoiceEventType;
  duration?: number;    // milliseconds
  text?: string;        // transcription or TTS text
  speaker?: string;     // identified speaker
  metadata?: Record<string, unknown>;
}

export interface TimelineQuery {
  from?: Date;
  to?: Date;
  types?: VoiceEventType[];
  speaker?: string;
  textSearch?: string;
  limit?: number;
}

function dateKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function getLogPath(date?: Date): string {
  return join(TIMELINE_DIR, `${dateKey(date)}.jsonl`);
}

/** Log a voice event */
export function logEvent(
  type: VoiceEventType,
  opts?: {
    text?: string;
    speaker?: string;
    duration?: number;
    metadata?: Record<string, unknown>;
  },
): VoiceEvent {
  const event: VoiceEvent = {
    timestamp: new Date().toISOString(),
    type,
    ...opts,
  };

  const logPath = getLogPath();
  appendFileSync(logPath, JSON.stringify(event) + "\n", "utf-8");

  return event;
}

/** Read events from a specific day */
export function getEventsForDay(date?: Date): VoiceEvent[] {
  const logPath = getLogPath(date);
  if (!existsSync(logPath)) return [];

  return readFileSync(logPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean) as VoiceEvent[];
}

/** Query the timeline with filters */
export function queryTimeline(query: TimelineQuery = {}): VoiceEvent[] {
  const from = query.from ?? new Date(Date.now() - 7 * 86400_000); // default: last 7 days
  const to = query.to ?? new Date();
  const limit = query.limit ?? 500;

  // Iterate over date range
  const events: VoiceEvent[] = [];
  const current = new Date(from);

  while (current <= to && events.length < limit) {
    const dayEvents = getEventsForDay(current);

    for (const evt of dayEvents) {
      const evtTime = new Date(evt.timestamp);
      if (evtTime < from || evtTime > to) continue;
      if (query.types && !query.types.includes(evt.type)) continue;
      if (query.speaker && evt.speaker !== query.speaker) continue;
      if (query.textSearch && (!evt.text || !evt.text.toLowerCase().includes(query.textSearch.toLowerCase()))) continue;

      events.push(evt);
      if (events.length >= limit) break;
    }

    current.setDate(current.getDate() + 1);
  }

  return events;
}

/** Get a summary of voice activity for a day */
export function getDaySummary(date?: Date): {
  totalEvents: number;
  byType: Record<string, number>;
  speakers: string[];
  totalDurationMs: number;
  firstEvent?: string;
  lastEvent?: string;
} {
  const events = getEventsForDay(date);
  const byType: Record<string, number> = {};
  const speakers = new Set<string>();
  let totalDuration = 0;

  for (const evt of events) {
    byType[evt.type] = (byType[evt.type] || 0) + 1;
    if (evt.speaker) speakers.add(evt.speaker);
    if (evt.duration) totalDuration += evt.duration;
  }

  return {
    totalEvents: events.length,
    byType,
    speakers: Array.from(speakers),
    totalDurationMs: totalDuration,
    firstEvent: events[0]?.timestamp,
    lastEvent: events[events.length - 1]?.timestamp,
  };
}

/** List all days that have timeline data */
export function listTimelineDays(): string[] {
  if (!existsSync(TIMELINE_DIR)) return [];
  return readdirSync(TIMELINE_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.replace(".jsonl", ""))
    .sort();
}

/** Clear timeline data older than N days */
export function pruneTimeline(keepDays = 30): number {
  const cutoff = new Date(Date.now() - keepDays * 86400_000);
  const days = listTimelineDays();
  let removed = 0;

  for (const day of days) {
    if (new Date(day) < cutoff) {
      const p = join(TIMELINE_DIR, `${day}.jsonl`);
      try {
        require("node:fs").unlinkSync(p);
        removed++;
      } catch {}
    }
  }

  return removed;
}
