// A `_` key is the server's channel to a tool (_cwd, _sessionId, _operationId,
// _onProgress, _lastUserMessage, …). The server stamps them after the model
// has spoken, and the tools trust them because of that. So every object the
// model wrote loses its `_` keys before it becomes a tool's arguments: the
// call's own arguments at dispatch (resolve-tool.ts), and any nested object a
// tool spreads into the arguments it hands on (a collapsed family's `params`,
// an op_submit_batch task). The trusted stamps are applied after, never under.

/** Whether `key` is a server-stamped argument name rather than a model one. */
export function isInternalArgKey(key: string): boolean {
  return key.startsWith("_");
}

/** A copy of a model-written object without any server-channel keys. */
export function withoutInternalArgs(modelArgs: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(modelArgs).filter(([key]) => !isInternalArgKey(key)));
}
