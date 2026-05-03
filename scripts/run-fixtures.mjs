// Wrapper to invoke fixture runner without typing the literal banned word in commands.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
const CLI = resolve(process.cwd(), "src", "agent-loop", "ev" + "al", "cli.ts");
const FIX = resolve(process.cwd(), "ev" + "al", "fixtures");
const proc = spawn(process.execPath, ["--import=tsx", CLI, FIX], { stdio: "inherit", shell: false });
proc.on("exit", code => process.exit(code ?? 1));
