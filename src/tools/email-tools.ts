import type { ToolDefinition } from "../types.js";
import { emailSend } from "./email-send-tool.js";
import { emailRead, emailSearch } from "./email-read-tools.js";
import { emailDraft, emailSetup } from "./email-compose-tools.js";

export const emailTools: ToolDefinition[] = [emailSend, emailRead, emailSearch, emailDraft, emailSetup];
export function createEmailTools(): ToolDefinition[] { return emailTools; }
