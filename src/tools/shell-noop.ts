/**
 * A shell command that only prints its own words runs nothing. A model that
 * sends one means to call a tool and is narrating into the shell: Grok, told
 * to start the /greenfield build, sent `echo "calling start_app_build"` and
 * forty more like it over three turns, each answered "[ok]", while the tool sat
 * in its list (2026-11-27). Such a command is not run; the answer names the
 * tool it mentions, so the next call can be the real one.
 */

/** The command's own words when all it does is print literal text (`echo`,
 *  `printf`, `Write-Output`, `Write-Host`, `true`, `:`), else null. Anything
 *  that expands, redirects, pipes or chains does real work and is left alone. */
export function printedOnlyText(command: string): string | null {
  const c = command.trim();
  if (!c || /[|;&<>`$]|\r|\n/.test(c)) return null;
  if (c === "true" || c === ":") return "";
  const m = /^(?:echo|printf|Write-Output|Write-Host)(?:\s+-[a-zA-Z]+)*(?:\s+([\s\S]*))?$/i.exec(c);
  if (!m) return null;
  return (m[1] ?? "").replace(/^(["'])([\s\S]*)\1$/, "$2");
}

/** The refusal for such a command. `isTool` says whether a word names a tool. */
export function printOnlyRefusal(command: string, printed: string, isTool: (name: string) => boolean): string {
  const named = [...new Set(printed.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [])].filter(isTool);
  const which = named.length > 0
    ? ` ${named.map((n) => `\`${n}\``).join(", ")} ${named.length === 1 ? "is a tool" : "are tools"}: call ${named.length === 1 ? "it" : "them"} by name.`
    : " If you meant to call a tool, call it by its name.";
  return `Not run: \`${command.trim()}\` only prints its own words, so it does nothing.${which} Say what you are doing in your reply, not in the shell.`;
}
