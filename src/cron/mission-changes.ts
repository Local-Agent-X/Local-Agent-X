/**
 * Every change to the missions list reaches every open tab. Each way a job
 * changes goes through CronService — the routes, the mission_schedule_* tools,
 * firing a heartbeat agent, a run starting and ending — and the service raises
 * one notice for it: every job write (saveJobs), a run's start, a settings
 * change. Notices raised in the same tick coalesce, so one change is one
 * frame however many writes it took (a run's end saves its outcome, then may
 * save an auto-pause). The server turns each notice into the frame every tab
 * redraws its Missions list from (registerCronRunner).
 */

import type { GlobalFrame } from "../chat-ws/frames.js";

export const MISSIONS_CHANGED_FRAME: GlobalFrame = { type: "settings_changed", settings: { missions: true } };

export class MissionChangeNotice {
  private listener: (() => void) | null = null;
  private pending = false;

  listen(listener: () => void): void { this.listener = listener; }

  raise(): void {
    if (!this.listener || this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      this.listener?.();
    });
  }
}

export function broadcastMissionChanges(
  cron: { onChange(listener: () => void): void },
  broadcastAll: (frame: GlobalFrame) => unknown,
): void {
  cron.onChange(() => { broadcastAll(MISSIONS_CHANGED_FRAME); });
}
