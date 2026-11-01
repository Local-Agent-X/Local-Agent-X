/**
 * Which credentials are MODEL-PROVIDER keys: a key for a service whose job is
 * inference, the job the agent itself already does.
 *
 * The agent once asked the user for an Anthropic key so a script could call
 * the Messages API and write recipes, work it could have written itself; a
 * user who did not know better would have paid for inference twice. The
 * secret-request tools read this to tell the user, on the prompt itself, that
 * the agent never needs such a key for its own work, and to tell the agent
 * the same in the tool result. The two legitimate reasons remain the user's
 * call: their own app calls the provider, or they want the agent to run on
 * that provider (`anthropic-api`, `openai`, `xai`, `gemini`, `cerebras` read
 * their key from the vault under the names pinned in the test).
 */

const MODEL_PROVIDERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(anthropic|claude)\b/, "Anthropic"],
  [/\b(openai|codex)\b/, "OpenAI"],
  [/\b(gemini|google[ _]?(generative|gen)[ _]?ai)\b/, "Google Gemini"],
  [/\b(xai|grok)\b/, "xAI"],
  [/\bcerebras\b/, "Cerebras"],
  [/\bollama\b/, "Ollama"],
  [/\bopenrouter\b/, "OpenRouter"],
  [/\bgroq\b/, "Groq"],
  [/\bmistral\b/, "Mistral"],
  [/\bdeepseek\b/, "DeepSeek"],
  [/\bcohere\b/, "Cohere"],
  [/\bperplexity\b/, "Perplexity"],
  [/\b(hugging ?face|hf)\b/, "Hugging Face"],
];

/**
 * The model provider a requested secret is for, by its name and service, or
 * null when it is an ordinary credential. Underscores in a name are word
 * breaks, so `ANTHROPIC_API_KEY` and a service of "Anthropic" both match.
 */
export function modelProviderOfSecret(name: string, service?: string): string | null {
  const text = `${name} ${service ?? ""}`.toLowerCase().replace(/_/g, " ");
  for (const [pattern, provider] of MODEL_PROVIDERS) {
    if (pattern.test(text)) return provider;
  }
  return null;
}

/**
 * What the prompt shows the user above the field for a model-provider key,
 * so a user who does not know the agent is already a model does not take the
 * ask at face value.
 */
export function modelProviderKeyNotice(provider: string): string {
  return (
    `Local Agent X already runs on its own model and never needs a key for ${provider} to think, write or generate anything. ` +
    `Save this only if it is for your own app or project, or to run Local Agent X on ${provider} (pick it in Settings after saving).`
  );
}

/**
 * What the agent is told in the tool result for a model-provider key: the
 * work it was reaching for a key to do is its own.
 */
export function modelProviderKeyGuidance(provider: string): string {
  return (
    `${provider} is a model provider: you never need its key for your own work. ` +
    `Writing, classifying, summarizing and generating are yours, inline or fanned out with agent_spawn / op_submit_batch. ` +
    `The prompt tells the user so; it is theirs to save only if their own app calls ${provider}, or they want to run on it.`
  );
}
