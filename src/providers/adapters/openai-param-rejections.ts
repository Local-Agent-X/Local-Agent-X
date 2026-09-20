/**
 * Which 400s name a parameter the OpenAI HTTP adapter can drop and retry
 * without. One matcher per param, each matching the server's UNSUPPORTED
 * phrasing and only that: a VALUE error ("too large", "must be a boolean",
 * "invalid schema") is a sizing or caller bug that must propagate untouched
 * and never latch the learned per-(baseURL, model) store.
 */

// Some models named as reasoners still 400 the whole request on the
// `reasoning_effort` param (grok-4.20-0309-reasoning is the live case:
// "does not support parameter reasoningEffort"). Match that specific
// rejection — and only that — so the catch strips reasoning_effort and
// retries, while every other 400 (rate limit, context length, auth) still
// propagates untouched.
export function isReasoningEffortRejection(message: string | undefined): boolean {
  return /does not support parameter\s+reasoning_?effort/i.test(message ?? "");
}

// o1/o3/o-series models 400 the whole request on a non-default `temperature`
// ("Unsupported value: 'temperature' does not support 0.7 with this model.
// Only the default (1) value is supported."). Match that specific rejection —
// and only that — so the catch drops the temperature field (letting the API
// use its default) and retries, while every other 400 still propagates.
export function isTemperatureRejection(message: string | undefined): boolean {
  return /unsupported value:\s*'?temperature|temperature.*only the default|does not support.*temperature/i.test(
    message ?? "",
  );
}

// Not every OpenAI-compatible server implements `response_format` with
// json_schema (strict servers 400 the whole request: "Invalid parameter:
// 'response_format' of type 'json_schema' is not supported with this model").
// Match UNSUPPORTED phrasing only — same discipline as the reasoning_effort
// and temperature matchers above. Schema-validation 400s also name the param
// ("Invalid schema for response_format 'x': ... 'additionalProperties' is
// required...", "Invalid 'response_format.json_schema.name'...") but those
// are a CALLER bug: they must propagate untouched, never mark the learned
// store, and never silently heal — otherwise one bad schema permanently
// disables structured output for the (baseURL, model).
export function isResponseFormatRejection(message: string | undefined): boolean {
  return /does not support(?: parameter)?\s+'?response_?format|response_?format'?[^.]*\bnot supported|unsupported (?:parameter:?\s*)?'?response_?format/i.test(
    message ?? "",
  );
}

// o-series models 400 the whole request on `max_tokens` ("Unsupported
// parameter: 'max_tokens' is not supported with this model. Use
// 'max_completion_tokens' instead."), and a strict OpenAI-compat server may
// not implement the param at all. Match UNSUPPORTED phrasing only — a VALUE
// 400 ("max_tokens is too large: …") is a sizing problem that must propagate
// untouched and never latch the learned store, same discipline as the
// matchers above.
export function isMaxTokensRejection(message: string | undefined): boolean {
  return /unsupported parameter:?\s*'?max_tokens|does not support(?: parameter)?\s+'?max_tokens|'?max_tokens'?\s+is\s+not\s+supported/i.test(
    message ?? "",
  );
}

// stream_options.include_usage makes an OpenAI-compatible stream emit a final
// usage-only chunk (it's omitted otherwise). It used to be requested only from
// known cloud providers, which left every LOCAL run with zero recorded tokens:
// no cost, no cache-hit rate, no way to see a truncated prompt. Ollama honours
// the param (verified 0.34.2, and it adds prompt_tokens_details.cached_tokens),
// so it is requested everywhere; a strict server that 400s on it is learned
// per (baseURL, model) and skipped from then on, the same self-heal as the
// other params. Match UNSUPPORTED phrasing only.
export function isStreamOptionsRejection(message: string | undefined): boolean {
  return /unsupported parameter:?\s*'?stream_options|does not support(?: parameter)?\s+'?stream_options|'?stream_options'?[^.]*\bnot supported|unknown (?:parameter|field):?\s*'?stream_options/i.test(
    message ?? "",
  );
}
