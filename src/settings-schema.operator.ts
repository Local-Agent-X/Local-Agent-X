/**
 * Settings only the user changes, from their own Settings page: each hands the
 * agent authority it must not grant itself. The workspace is where the agent
 * may write (and what the Windows cage's sandbox account may write), the port
 * is where the server and its UI live, localRuntimes names hosts the agent's
 * HTTP tools may then reach (security/layer/security-config.ts
 * manualRuntimeHostPorts), customBaseUrl is where a custom provider's API key
 * is sent, and threat tunes how much evidence the threat engine needs before
 * it restricts a session.
 *
 * Part of FLIPPABLE_SETTINGS (settings-schema.ts). POST /api/settings applies
 * them only for a request carrying the operator token; the `setting` tool
 * never does. `where` is what a refusal tells the agent to send the user to.
 */
import { z } from "zod";
import type { FlippableSetting } from "./settings-schema.js";

const SERVER = "Settings → Account → Server";

export const OPERATOR_SETTINGS: ReadonlyArray<FlippableSetting> = [
  {
    field: "workspace",
    owner: "operator",
    where: SERVER,
    validate: z.string().min(1),
    runtime: false,
    description: "Folder the agent's files and apps live in. Saved to config.json; takes effect, and moves the existing files, at the next start",
  },
  {
    field: "port",
    owner: "operator",
    where: SERVER,
    validate: z.number().int().min(1).max(65535),
    runtime: false,
    description: "Port the server and its UI listen on. Saved to config.json; takes effect at the next start",
  },
  {
    field: "localRuntimes",
    owner: "operator",
    where: "Settings → AI & Models → Local Runtimes",
    validate: z.array(z.object({ kind: z.enum(["ollama", "openai-compat"]), baseUrl: z.string(), label: z.string().optional() })),
    runtime: false,
    description: "Manually added local model servers. Each one's host:port becomes reachable by the agent's HTTP tools",
  },
  {
    field: "customBaseUrl",
    owner: "operator",
    where: "Settings → AI & Models → Model Provider",
    validate: z.string(),
    runtime: false,
    description: "Base URL of the custom OpenAI-compatible provider. Its API key is sent there",
  },
  {
    field: "threat",
    owner: "operator",
    where: "the threat section of their settings.json",
    validate: z.object({ startingBudget: z.number().min(0), decayPerHour: z.number().min(0), decayPerTurn: z.number().min(0) }).partial(),
    runtime: false,
    description: "Threat-engine calibration: how much risk evidence a session may accumulate before it is restricted, and how fast it decays",
  },
];
