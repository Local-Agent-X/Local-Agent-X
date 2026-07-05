import { stripCodeBlocks } from "./code-strip.js";
import { evaluateClaimGrounding, type EvidenceKind } from "./claim-grounding.js";

const CODEBASE_SUBJECT =
  /\b(?:code\s*base|codebase|repo(?:sitory)?|project|harness|agent|loop|middleware|guard|verifier|runtime|system|module|implementation|architecture|subsystem|class\s+of\s+failures?)\b/i;

const ADVICE_REQUEST =
  /\b(?:what(?:'s|\s+is)\s+the\s+move|what\s+should\s+we\s+do|what\s+do\s+we\s+do\s+next|where\s+do\s+we\s+still\s+struggle|how\s+(?:do|should|can)\s+we\s+(?:fix|handle|improve|address)|should\s+we|recommend|next\s+step|what\s+needs\s+to\s+change)\b/i;

const IMPLEMENTATION_ADVICE =
  /\b(?:we\s+should|the\s+move\s+is|next\s+(?:step|move|concrete\s+(?:harness\s+)?fix)|I\s+would|recommend|add\s+(?:a|an|the)?\s*(?:guard|gate|middleware|verifier|test|hook)|implement|wire|extend|change\s+(?:the|this)|fix\s+(?:this|the)?|make\s+\w+\s+do|turn\s+this\s+into)\b/i;

const FRESHNESS_ACK =
  /\b(?:need\s+to\s+(?:read|inspect|check)\s+(?:the\s+)?(?:code|repo|codebase|files)|before\s+(?:I|we)\s+(?:recommend|decide|change)|I\s+(?:need|should)\s+(?:read|inspect|check)|can't\s+say\s+without\s+(?:reading|inspecting|checking)|should\s+read\s+the\s+code)\b/i;

const CODE_EVIDENCE_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "bash",
  "shell",
  "ari_file",
  "ari_retrieval",
]);

const NON_CODE_EVIDENCE_TOOLS = new Set([
  "memory_search",
  "memory_recall",
  "search_past_sessions",
  "tool_search",
]);

export function looksLikeCodebaseAdviceRequest(userMessage: string): boolean {
  const t = stripCodeBlocks(userMessage || "");
  return CODEBASE_SUBJECT.test(t) && ADVICE_REQUEST.test(t);
}

export function looksLikeImplementationAdvice(text: string): boolean {
  const t = stripCodeBlocks(text || "");
  if (!t) return false;
  if (FRESHNESS_ACK.test(t)) return false;
  return IMPLEMENTATION_ADVICE.test(t);
}

export function hasFreshCodebaseEvidence(toolsCalledThisOp: Set<string>): boolean {
  return codebaseAdviceEvidence(toolsCalledThisOp).includes("code-read");
}

function codebaseAdviceEvidence(toolsCalledThisOp: Set<string>): EvidenceKind[] {
  for (const rawName of toolsCalledThisOp) {
    const name = rawName.toLowerCase();
    if (NON_CODE_EVIDENCE_TOOLS.has(name) || name.startsWith("memory_")) continue;
    if (CODE_EVIDENCE_TOOLS.has(name)) return ["code-read"];
    if (/(?:^|_)(?:read|grep|glob|search|inspect|list|fetch)(?:_|$)/.test(name)) return ["code-read"];
  }
  return [];
}

export function checkUngroundedCodebaseAdvice(
  userMessage: string,
  assistantText: string,
  toolsCalledThisOp: Set<string>,
): string | null {
  if (!looksLikeCodebaseAdviceRequest(userMessage)) return null;
  if (!looksLikeImplementationAdvice(assistantText)) return null;
  const verdict = evaluateClaimGrounding("repo-advice", codebaseAdviceEvidence(toolsCalledThisOp));
  return verdict.grounded ? null : verdict.message;
}
