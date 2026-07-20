import { stepsPlan, wantsOllama, wantsOllamaMemoryModel } from "../../scripts/installer/contract.mjs";
import { createReporter } from "../../scripts/installer/reporter.mjs";

const mode = process.argv[2] || "complete";
const ipcMode = process.argv.includes("--ipc");
const reporter = createReporter({ ipcMode });

if (mode === "wait") {
  reporter.ipc({ type: "plan", steps: stepsPlan("linux") });
  reporter.step("node");
  setInterval(() => {}, 1000);
} else {
  const platform = process.argv.find((arg) => arg.startsWith("--platform="))?.slice(11) || "linux";
  reporter.ipc({ type: "plan", steps: stepsPlan(platform) });
  reporter.log(`ollama=${wantsOllama()}`);
  reporter.log(`ollama-memory-model=${wantsOllamaMemoryModel()}`);
  if (mode === "optional") {
    reporter.step("ollama");
    reporter.fail("unavailable");
  } else if (mode === "fatal") {
    reporter.step("node");
    reporter.fail("unsupported");
  }
  if (mode !== "fatal") reporter.ipc({ type: "complete" });
}
