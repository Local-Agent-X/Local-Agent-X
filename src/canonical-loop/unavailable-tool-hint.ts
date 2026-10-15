// A refusal's advice checked against the tools this run can actually call.
//
// Refusals are written where the run's toolset isn't known (the security layer, the
// shell policy, the approval floor), so their advice names tools generically: "Delete
// them with delete_file instead", "use http_request". A build worker has neither, so
// following the advice fails a second time and the model loses a turn working out
// why (2026-10-14). The canonical dispatcher holds the run's tools; for every result
// that isn't ok it adds one line naming the suggested tools this run can't call.
//
// Only distinctive mentions count: a name with an underscore (delete_file) or one in
// backticks (`grep`). A bare "read" or "edit" is English as often as a tool name.

/** Registered tools the text names that `isCallable` rejects, in order of mention. */
export function unavailableToolsNamed(
  text: string,
  isTool: (name: string) => boolean,
  isCallable: (name: string) => boolean,
): string[] {
  const found: string[] = [];
  const consider = (name: string): void => {
    if (found.includes(name) || !isTool(name) || isCallable(name)) return;
    found.push(name);
  };
  for (const m of text.matchAll(/`([a-z][a-z0-9_]*)`/g)) consider(m[1]!);
  for (const m of text.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)) consider(m[1]!);
  return found;
}

/** `text` with a closing line naming the advice this run can't follow, or unchanged. */
export function noteUnavailableTools(
  text: string,
  isTool: (name: string) => boolean,
  isCallable: (name: string) => boolean,
): string {
  const missing = unavailableToolsNamed(text, isTool, isCallable);
  if (missing.length === 0) return text;
  return `${text}\nNot available in this run: ${missing.join(", ")}. That advice won't work here: find another way, or tell the user what you couldn't do.`;
}
