/**
 * The two names the first-turn identity ask keys on, carried in a section no
 * budget can shed. The ask's precondition reads `Name:` out of
 * <agent_identity> / <user_profile>, and both live in the memory context
 * block — which the weak tier strips outright (build-context.ts), the
 * constrained-local budget degrades (15 such turns in one day's live log), and
 * the stable-prefix path moves out of the system prompt. Every one of those
 * left a named agent re-asking "what's my call sign". The names are extracted
 * BEFORE any of that and rendered as <identity_names>, policy required.
 */

export interface IdentityNames { agent?: string; user?: string }

const PLACEHOLDER = /^\(?\s*not yet named\s*\)?$|^\(?\s*unknown\s*\)?$|^n\/a$|^none$|^-+$/i;

function nameIn(block: string | undefined): string | undefined {
  if (!block) return undefined;
  const m = /^\s*-?\s*Name:\s*(.+?)\s*$/im.exec(block);
  if (!m) return undefined;
  const value = m[1].trim();
  return value && !PLACEHOLDER.test(value) ? value : undefined;
}

function tagged(contextBlock: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(contextBlock);
  return m ? m[1] : undefined;
}

/** The first real `Name:` inside <agent_identity> and inside <user_profile>. */
export function identityNamesFrom(contextBlock: string): IdentityNames {
  const out: IdentityNames = {};
  const agent = nameIn(tagged(contextBlock, "agent_identity"));
  const user = nameIn(tagged(contextBlock, "user_profile"));
  if (agent) out.agent = agent;
  if (user) out.user = user;
  return out;
}

/** The section text, or "" when neither name is known (then the ask is right). */
export function renderIdentityNames(names: IdentityNames): string {
  if (!names.agent && !names.user) return "";
  const lines = ["<identity_names>"];
  if (names.agent) lines.push(`- Agent Name: ${names.agent}`);
  if (names.user) lines.push(`- User Name: ${names.user}`);
  lines.push("</identity_names>");
  return lines.join("\n");
}
