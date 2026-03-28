// ── Config Hot-Reload ── Watch config file and reload without restart

import { watch, readFileSync, existsSync, type FSWatcher } from "node:fs";
import { EventBus } from "./event-bus.js";

type ConfigData = Record<string, unknown>;
type OnChangeCallback = (newConfig: ConfigData, oldConfig: ConfigData) => void;

function parseConfig(raw: string): ConfigData {
  return JSON.parse(raw) as ConfigData;
}

function validateConfig(data: unknown): data is ConfigData {
  return data !== null && typeof data === "object" && !Array.isArray(data);
}

export class ConfigWatcher {
  private watcher: FSWatcher | null = null;
  private currentConfig: ConfigData = {};
  private configPath: string = "";
  private onChange: OnChangeCallback | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  start(configPath: string, onChange: OnChangeCallback): void {
    if (this.running) {
      this.stop();
    }

    if (!existsSync(configPath)) {
      throw new Error(`Config file not found: ${configPath}`);
    }

    this.configPath = configPath;
    this.onChange = onChange;

    // Load initial config
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseConfig(raw);
    if (!validateConfig(parsed)) {
      throw new Error(`Invalid config file format at ${configPath}`);
    }
    this.currentConfig = parsed;
    this.running = true;

    // Watch for changes
    this.watcher = watch(configPath, (_eventType) => {
      this.scheduleReload();
    });

    this.watcher.on("error", (err) => {
      EventBus.emit("error", { source: "config-watcher", error: err.message });
    });
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.running = false;
    this.onChange = null;
  }

  getCurrentConfig(): Readonly<ConfigData> {
    return { ...this.currentConfig };
  }

  isRunning(): boolean {
    return this.running;
  }

  private scheduleReload(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.reload();
    }, 500);
  }

  private reload(): void {
    if (!this.configPath || !existsSync(this.configPath)) return;

    let raw: string;
    try {
      raw = readFileSync(this.configPath, "utf-8");
    } catch {
      EventBus.emit("error", {
        source: "config-watcher",
        error: `Failed to read config file: ${this.configPath}`,
      });
      return;
    }

    let parsed: unknown;
    try {
      parsed = parseConfig(raw);
    } catch {
      EventBus.emit("error", {
        source: "config-watcher",
        error: `Invalid JSON in config file: ${this.configPath}`,
      });
      return;
    }

    if (!validateConfig(parsed)) {
      EventBus.emit("error", {
        source: "config-watcher",
        error: "Config validation failed: expected a JSON object",
      });
      return;
    }

    const oldConfig = this.currentConfig;
    this.currentConfig = parsed;

    // Notify callback
    if (this.onChange) {
      try {
        this.onChange(parsed, oldConfig);
      } catch {
        // Callback errors should not break the watcher
      }
    }

    // Emit on event bus
    EventBus.emit("config:changed", { newConfig: parsed, oldConfig });
  }
}
