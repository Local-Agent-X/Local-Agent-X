const GENERATED_AGENT_NAME_RE = /^(?:field-agent|primal-agent)-\d+-[a-z0-9]+$/i;

export function isGeneratedAgentRunName(name: string | undefined | null): boolean {
  return GENERATED_AGENT_NAME_RE.test((name || "").trim());
}

export function formatAgentDisplayName(input: {
  name?: string | null;
  role?: string | null;
  task?: string | null;
}): string {
  const name = clean(input.name);
  if (name && !isGeneratedAgentRunName(name)) return name;

  const role = humanizeRole(input.role);
  const task = summarizeTask(input.task);
  if (role && task) return `${role}: ${task}`;
  if (role) return role;
  if (task) return `Agent: ${task}`;
  return "Agent";
}

function clean(value: string | undefined | null): string {
  return (value || "").replace(/\s+/g, " ").trim();
}

function humanizeRole(value: string | undefined | null): string {
  const role = clean(value);
  if (!role) return "";
  return role
    .replace(/[-_]+/g, " ")
    .replace(/\bagent\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

function summarizeTask(value: string | undefined | null): string {
  const task = clean(value)
    .replace(/^start\s+(?:a\s+)?background\s+(?:worker|agent)\s+to\s+/i, "")
    .replace(/^run\s+(?:a\s+)?/i, "");
  if (!task) return "";
  const firstSentence = task.split(/(?<=[.!?])\s+/)[0] || task;
  return firstSentence.length > 72 ? `${firstSentence.slice(0, 69).trimEnd()}...` : firstSentence;
}
