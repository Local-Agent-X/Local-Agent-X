import { collectSubtreeRules } from "./agents-rules.js";

export async function buildSelfEditPrompt(task: string, scopeHintArg: string): Promise<string> {
  const scopeHint = scopeHintArg ? `\n\nScope hint: ${scopeHintArg}` : "";
  const subtreeRules = await collectSubtreeRules(scopeHintArg);
  const rulesBlock = subtreeRules
    ? `\n\nARCHITECTURAL RULES (follow these strictly — they encode what's allowed in this part of the tree):\n\n${subtreeRules}\n`
    : "";

  return (
    `You are editing the Local Agent X TypeScript codebase to fix a reported bug or implement a change.\n\n` +
    `Task: ${task}${scopeHint}${rulesBlock}\n\n` +
    `Constraints:\n` +
    `- Source is under src/. Public assets under public/. Config under config/.\n` +
    `- Build with: npm run build\n` +
    `- Do NOT commit or push — just make the edit and run the build to verify compilation.\n` +
    `- Make the MINIMUM change needed. No refactoring or unrelated cleanup.\n` +
    `- If the bug is ambiguous, diagnose first (read relevant files, grep logs at /tmp/lax-server.log), then patch.\n` +
    `- If your change breaks the build, revert it — don't leave the tree in a broken state.\n\n` +
    `When done, reply in this format (nothing else):\n` +
    `DIAGNOSIS: <one-line root cause>\n` +
    `CHANGED: <comma-separated file paths>\n` +
    `BUILD: ok | broken\n` +
    `NOTE: <anything the user needs to know, e.g. 'restart server to apply'>`
  );
}
