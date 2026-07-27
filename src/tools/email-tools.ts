/**
 * The email barrel — the ONE list registry-build.ts spreads into `allTools`.
 *
 * A tool absent from here is dead code no matter how complete it is: its own
 * unit tests stay green, so nothing goes red to say the model cannot call it.
 * Adding an export here is only the first of several registrations — see
 * test/email-registration-funnel.test.ts for the full set (policy table, ARI
 * action map, external-ingestion registry, capability classes, plan mode,
 * transport tools) and the mutation each one guards against.
 */
import type { ToolDefinition } from "../types.js";
import { emailSend } from "./email-send-tool.js";
import { emailRead, emailSearch, emailReadMessage } from "./email-read-tools.js";
import { emailFolders } from "./email-folder-tools.js";
import { emailDelete, emailMark } from "./email-mutate-tools.js";
import { emailDraft, emailSetup } from "./email-compose-tools.js";

export const emailTools: ToolDefinition[] = [
  emailSend, emailRead, emailSearch, emailReadMessage, emailFolders,
  emailDelete, emailMark, emailDraft, emailSetup,
];
export function createEmailTools(): ToolDefinition[] { return emailTools; }
