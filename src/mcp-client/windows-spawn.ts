import { existsSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";

export function cmdQuote(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

export interface WindowsMcpSpawn {
  cmd: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

export function buildWindowsMcpSpawn(resolvedPath: string, args: string[], env: NodeJS.ProcessEnv = process.env): WindowsMcpSpawn {
  const extension = extname(resolvedPath).toLowerCase();
  if (extension !== ".cmd" && extension !== ".bat") return { cmd: resolvedPath, args, windowsVerbatimArguments: false };
  if ([resolvedPath, ...args].some(arg => /[%\r\n]/.test(arg))) {
    throw new Error("Windows MCP .cmd/.bat paths and arguments cannot contain %, CR, or LF because cmd.exe would expand or split them");
  }
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  const cmd = env.ComSpec || env.COMSPEC || join(systemRoot, "System32", "cmd.exe");
  if (!isAbsolute(cmd) || !existsSync(cmd)) throw new Error("Could not resolve a trusted absolute cmd.exe path for MCP launch");
  const commandLine = `"${[cmdQuote(resolvedPath), ...args.map(cmdQuote)].join(" ")}"`;
  return { cmd, args: ["/d", "/v:off", "/s", "/c", commandLine], windowsVerbatimArguments: true };
}
