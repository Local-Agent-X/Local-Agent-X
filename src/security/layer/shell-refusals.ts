/**
 * What a shell refusal tells the model to do instead, for the command-shape
 * rules in shell-policy.ts and shell-detectors.ts.
 *
 * Every refusal names a way that works, or says plainly that the user has to
 * do it. On Terminal-Bench (2026-10-19) refusals that only said what was wrong
 * ("don't background processes with &", "possible obfuscation") were retried
 * dozens of times and cost tasks that had a sanctioned path all along.
 * shell-refusals.test.ts pins one command per refusal and the way out it names.
 */

export const BACKGROUND_REFUSAL =
  "Blocked: a bare & backgrounds a process the shell cannot track. To keep a server or watcher running, " +
  "start it with the process_start tool: it stays up, process_status reads its output, and its port becomes " +
  "reachable. To run commands one after another, join them with &&.";

export const NEWLINE_REFUSAL =
  "Blocked: a newline outside quotes chains commands. Put multi-line code inside a single quoted -c/-e argument, " +
  "e.g. python3 -c 'line1\\nline2', or write it to a file and run that.";

export const SEMICOLON_REFUSAL =
  "Blocked: ; runs the next command even when the one before it failed. Join commands with && instead, " +
  "or run them as separate calls.";

/** Shared by every nested-command construct ($(...), backticks, ( subshells ), <(...)). */
export const NESTED_COMMAND_WAY_OUT =
  "Run the inner command as its own call first, then use its output in the next call, " +
  "or put the whole script in a file and run that file.";

/** A command word that is the output of a nested command (`$(echo curl) x`):
 *  which program runs is decided at run time, past every check. */
export const COMPUTED_COMMAND_REFUSAL =
  "Blocked: the program this command runs is the output of a nested command, so no check can see which program it is. " +
  "Run the nested command as its own call first (to find a program, `command -v NAME`), then call the program it printed by its name or path.";

export const ENCODED_PAYLOAD_REFUSAL =
  "Blocked: this command carries a long encoded blob, the usual shape of a hidden payload. " +
  "If it is data, write it to a file with the write tool and pass the file name to the command instead.";

export const DECODE_EXEC_REFUSAL =
  "Blocked: decoded text is passed to a shell or interpreter in the same command, which hides what runs. " +
  "Decoding by itself is fine: decode to the screen or to a file, read the result, then run what you need as its own call.";
