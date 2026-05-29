/**
 * Voice Command Shortcuts — maps spoken phrases to agent actions.
 * Supports exact matches, prefix matches, and regex patterns.
 */

export interface VoiceCommand {
  /** Patterns that trigger this command (case-insensitive) */
  patterns: string[];
  /** Action identifier */
  action: string;
  /** Parameters extracted from speech */
  params?: Record<string, string>;
  /** Human-readable description */
  description: string;
}

interface CommandMatch {
  command: VoiceCommand;
  confidence: number;
  extractedParams: Record<string, string>;
}

type ActionHandler = (params: Record<string, string>) => Promise<string> | string;

const builtinCommands: VoiceCommand[] = [
  {
    patterns: ["run mission *", "execute mission *", "start mission *", "launch mission *"],
    action: "run_mission",
    description: "Run a named mission",
  },
  {
    patterns: ["stop", "cancel", "abort", "halt"],
    action: "stop",
    description: "Stop current operation",
  },
  {
    patterns: ["status", "what's happening", "what are you doing", "current status"],
    action: "status",
    description: "Get current agent status",
  },
  {
    patterns: ["search for *", "find *", "look up *", "search *"],
    action: "search",
    description: "Search the web or workspace",
  },
  {
    patterns: ["open *", "launch *", "start *"],
    action: "open",
    description: "Open a file, app, or URL",
  },
  {
    patterns: ["read file *", "show file *", "read *", "show me *"],
    action: "read_file",
    description: "Read a file from workspace",
  },
  {
    patterns: ["save note *", "remember *", "take note *"],
    action: "save_note",
    description: "Save a note to workspace",
  },
  {
    patterns: ["list missions", "show missions", "what missions"],
    action: "list_missions",
    description: "List available missions",
  },
  {
    patterns: ["list tools", "show tools", "what tools", "available tools"],
    action: "list_tools",
    description: "List available tools",
  },
  {
    patterns: ["help", "what can you do", "commands"],
    action: "help",
    description: "Show available voice commands",
  },
  {
    patterns: ["mute", "be quiet", "silence", "shut up"],
    action: "mute",
    description: "Mute voice output",
  },
  {
    patterns: ["unmute", "speak", "voice on"],
    action: "unmute",
    description: "Unmute voice output",
  },
  {
    patterns: ["volume up", "louder"],
    action: "volume_up",
    description: "Increase volume",
  },
  {
    patterns: ["volume down", "quieter", "softer"],
    action: "volume_down",
    description: "Decrease volume",
  },
  {
    patterns: ["repeat", "say that again", "what did you say"],
    action: "repeat",
    description: "Repeat last response",
  },
];

/** Match a wildcard pattern against text, extracting the wildcard value */
function matchPattern(pattern: string, text: string): { matched: boolean; wildcard: string } {
  const lowerPattern = pattern.toLowerCase();
  const lowerText = text.toLowerCase().trim();

  if (!lowerPattern.includes("*")) {
    return { matched: lowerText === lowerPattern, wildcard: "" };
  }

  const parts = lowerPattern.split("*");
  const prefix = parts[0].trim();
  const suffix = (parts[1] || "").trim();

  if (!lowerText.startsWith(prefix)) return { matched: false, wildcard: "" };
  if (suffix && !lowerText.endsWith(suffix)) return { matched: false, wildcard: "" };

  const start = prefix.length;
  const end = suffix ? lowerText.length - suffix.length : lowerText.length;
  const wildcard = text.slice(start, end).trim();

  return { matched: true, wildcard };
}

/** Score how well text matches a command */
function scoreMatch(text: string, command: VoiceCommand): CommandMatch | null {
  for (const pattern of command.patterns) {
    const { matched, wildcard } = matchPattern(pattern, text);
    if (matched) {
      const params: Record<string, string> = {};
      if (wildcard) params.query = wildcard;
      return { command, confidence: 1.0, extractedParams: params };
    }
  }

  // Fuzzy: check if any pattern words appear in the text
  const textWords = new Set(text.toLowerCase().split(/\s+/));
  let bestScore = 0;

  for (const pattern of command.patterns) {
    const patternWords = pattern.replace("*", "").trim().split(/\s+/).filter(Boolean);
    const matches = patternWords.filter((w) => textWords.has(w)).length;
    const score = matches / patternWords.length;
    if (score > bestScore) bestScore = score;
  }

  if (bestScore >= 0.6) {
    return { command, confidence: bestScore * 0.8, extractedParams: {} };
  }

  return null;
}

export class VoiceCommandRouter {
  private commands: VoiceCommand[] = [...builtinCommands];
  private handlers = new Map<string, ActionHandler>();

  /** Register a custom command */
  addCommand(command: VoiceCommand): void {
    this.commands.push(command);
  }

  /** Register a handler for an action */
  onAction(action: string, handler: ActionHandler): void {
    this.handlers.set(action, handler);
  }

  /** Match spoken text to a command */
  match(text: string): CommandMatch | null {
    const matches: CommandMatch[] = [];

    for (const cmd of this.commands) {
      const m = scoreMatch(text, cmd);
      if (m) matches.push(m);
    }

    if (matches.length === 0) return null;
    matches.sort((a, b) => b.confidence - a.confidence);
    return matches[0];
  }

  /** Match and execute a voice command */
  async execute(text: string): Promise<{ action: string; result: string } | null> {
    const m = this.match(text);
    if (!m) return null;

    const handler = this.handlers.get(m.command.action);
    if (!handler) {
      return { action: m.command.action, result: `Command recognized: ${m.command.action}` };
    }

    const result = await handler(m.extractedParams);
    return { action: m.command.action, result };
  }

  /** List all registered commands */
  listCommands(): VoiceCommand[] {
    return [...this.commands];
  }
}

/** Create a pre-configured voice command router */
export function createVoiceRouter(): VoiceCommandRouter {
  return new VoiceCommandRouter();
}
