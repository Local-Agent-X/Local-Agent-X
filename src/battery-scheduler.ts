import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

export type TaskPriority = "critical" | "normal" | "low";

export interface ScheduledTask {
  id: string;
  name: string;
  priority: TaskPriority;
  execute: () => Promise<void>;
  createdAt: number;
}

interface BatteryStatus {
  level: number;
  pluggedIn: boolean;
  available: boolean;
}

function shell(
  cmd: string,
  args: string[]
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.toString().trim());
    });
  });
}

export class BatteryScheduler extends EventEmitter {
  private queue: ScheduledTask[] = [];
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private lastStatus: BatteryStatus = {
    level: 100,
    pluggedIn: true,
    available: false,
  };
  private taskCounter = 0;

  async start(pollMs = 30000): Promise<void> {
    await this.refreshBattery();
    this.pollInterval = setInterval(() => this.tick(), pollMs);
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  schedule(
    name: string,
    priority: TaskPriority,
    execute: () => Promise<void>
  ): string {
    const id = `task-${++this.taskCounter}-${Date.now()}`;
    const task: ScheduledTask = {
      id,
      name,
      priority,
      execute,
      createdAt: Date.now(),
    };

    if (priority === "critical") {
      this.runTask(task);
      return id;
    }

    if (this.canRun(priority)) {
      this.runTask(task);
    } else {
      this.queue.push(task);
      this.emit("task-deferred", { id, name, priority });
    }

    return id;
  }

  async getBatteryLevel(): Promise<number> {
    await this.refreshBattery();
    return this.lastStatus.level;
  }

  async isPluggedIn(): Promise<boolean> {
    await this.refreshBattery();
    return this.lastStatus.pluggedIn;
  }

  getQueuedTasks(): ScheduledTask[] {
    return [...this.queue];
  }

  cancelTask(id: string): boolean {
    const idx = this.queue.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    this.queue.splice(idx, 1);
    return true;
  }

  private canRun(priority: TaskPriority): boolean {
    if (priority === "critical") return true;
    if (priority === "low") return this.lastStatus.pluggedIn;
    // normal: run if battery > 30% or plugged in
    return this.lastStatus.pluggedIn || this.lastStatus.level > 30;
  }

  private async tick(): Promise<void> {
    await this.refreshBattery();

    if (this.lastStatus.level < 15 && !this.lastStatus.pluggedIn) {
      this.emit("battery-warning", {
        level: this.lastStatus.level,
        message: "Battery below 15%, deferring non-critical tasks",
      });
    }

    const ready: ScheduledTask[] = [];
    const deferred: ScheduledTask[] = [];

    for (const task of this.queue) {
      if (this.canRun(task.priority)) {
        ready.push(task);
      } else {
        deferred.push(task);
      }
    }

    this.queue = deferred;

    for (const task of ready) {
      this.runTask(task);
    }
  }

  private runTask(task: ScheduledTask): void {
    this.emit("task-started", { id: task.id, name: task.name });
    task.execute().then(
      () => this.emit("task-completed", { id: task.id, name: task.name }),
      (err) =>
        this.emit("task-failed", { id: task.id, name: task.name, error: err })
    );
  }

  private async refreshBattery(): Promise<void> {
    try {
      if (process.platform === "win32") {
        this.lastStatus = await this.readWindows();
      } else if (process.platform === "linux") {
        this.lastStatus = await this.readLinux();
      } else if (process.platform === "darwin") {
        this.lastStatus = await this.readMac();
      } else {
        this.lastStatus = { level: 100, pluggedIn: true, available: false };
      }
    } catch {
      this.lastStatus = { level: 100, pluggedIn: true, available: false };
    }
  }

  private async readWindows(): Promise<BatteryStatus> {
    const output = await shell("powershell", [
      "-Command",
      "(Get-CimInstance -ClassName Win32_Battery | Select-Object EstimatedChargeRemaining, BatteryStatus | ConvertTo-Json)",
    ]);
    if (!output) return { level: 100, pluggedIn: true, available: false };
    const data = JSON.parse(output) as {
      EstimatedChargeRemaining: number;
      BatteryStatus: number;
    };
    return {
      level: data.EstimatedChargeRemaining,
      pluggedIn: data.BatteryStatus === 2,
      available: true,
    };
  }

  private async readLinux(): Promise<BatteryStatus> {
    const base = "/sys/class/power_supply/BAT0";
    const capacityStr = await readFile(`${base}/capacity`, "utf-8");
    const statusStr = await readFile(`${base}/status`, "utf-8");
    return {
      level: parseInt(capacityStr.trim(), 10),
      pluggedIn: statusStr.trim() === "Charging" || statusStr.trim() === "Full",
      available: true,
    };
  }

  private async readMac(): Promise<BatteryStatus> {
    const output = await shell("pmset", ["-g", "batt"]);
    const pctMatch = output.match(/(\d+)%/);
    const level = pctMatch ? parseInt(pctMatch[1], 10) : 100;
    const pluggedIn = output.includes("AC Power");
    return { level, pluggedIn, available: true };
  }
}
