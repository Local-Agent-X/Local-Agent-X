// The commands nested inside a command line: `$(…)` and backtick
// substitutions, `<(…)` / `>(…)` process substitutions, `( subshells )`,
// `{ groups; }` and function bodies, `${ …; }` function substitutions. Each is
// taken out so evaluateShellCommand can judge it as a command in its own
// right, with every rule, instead of refusing the construct on sight; the line
// that remains holds a placeholder where each one was. Refusing on sight cost
// real work: `arch="$(uname -m)"`, `(cd sub && make)`, `which gcc || { echo
// missing; exit 1; }` (Terminal-Bench 2.0 reference solutions, 2026-10-19).
//
// Every character of the input lands in the remaining line or in one body, so
// nothing is judged less than before. A construct this reader cannot balance
// (an unterminated `$(`), or nesting past MAX_NESTING, is reported as
// unreadable, and the caller refuses it.

import { arithmeticSpanEnd, execBasename, resolveRealArgv0Index, tokenizeCommand } from "./shell-lex.js";

/** Where a substitution's output stands on the remaining line. */
export const NESTED_OUTPUT = "$NESTED_OUTPUT";
/** Where a version manager's environment printout stands (`eval "$(opam env)"`). */
export const ENVIRONMENT_SETUP_OUTPUT = "$ENVIRONMENT_SETUP";

/** Parentheses nested deeper than this are refused rather than walked. */
export const MAX_NESTING = 12;

export interface NestedSplit {
  /** The command line, each nested command replaced by its placeholder. */
  line: string;
  /** The nested commands, in order; each is judged as a whole command. */
  bodies: string[];
  /** Why the line could not be read, when it could not. */
  unreadable?: string;
}

// Version managers print shell code that sets up their environment, and
// `eval "$(tool …)"` is how every one of them is documented to be used. The
// printout is the installed tool's own output, the trust of running the tool.
const ENVIRONMENT_PRINTERS: Record<string, readonly string[]> = {
  opam: ["env", "config"], pyenv: ["init", "virtualenv-init"], rbenv: ["init"], nodenv: ["init"],
  goenv: ["init"], jenv: ["init"], plenv: ["init"], conda: ["shell.bash", "shell.zsh", "shell.posix"],
  mamba: ["shell.bash", "shell.zsh", "shell.posix"], micromamba: ["shell"], direnv: ["export", "hook"],
  brew: ["shellenv"], fnm: ["env"], mise: ["activate", "env", "hook-env"], luarocks: ["path"],
  "ssh-agent": ["", "-s"],
};

function isEnvironmentPrinter(body: string): boolean {
  if (/[`$();&|<>\n]/.test(body)) return false;
  const words = tokenizeCommand(body.trim());
  const allowed = ENVIRONMENT_PRINTERS[execBasename(words[0] ?? "")];
  return allowed !== undefined && allowed.includes(words[1] ?? "");
}

const placeholderFor = (body: string) => (isEnvironmentPrinter(body) ? ENVIRONMENT_SETUP_OUTPUT : NESTED_OUTPUT);

// Words after which the next word is a command again.
const COMMAND_KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "time"]);

/** Is `word` the whole word at `i` (bounded by start, space or an operator)? */
function wordAt(text: string, i: number, word: string): boolean {
  return text.startsWith(word, i) && /^$|[\s;&|(]/.test(text[i - 1] ?? "") && /^$|[\s;&|)]/.test(text[i + word.length] ?? "");
}

/** Index of the `)` that closes the region opened just before `i`, or -1. The
 *  region is shell text: quotes, escapes, comments, nested parens, backticks,
 *  and `case … esac`, whose `pattern)` closes a pattern, not the region —
 *  closing there would leave the pattern's command as a mere argument. */
function closingParen(text: string, i: number): number {
  let open = 1;
  let cases = 0;
  let quote: string | null = null;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") { if (c === "'") quote = null; continue; }
    if (c === "\\") { i++; continue; }
    if (c === "`") { i = closingBacktick(text, i + 1); if (i < 0) return -1; continue; }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "$" && text[i + 1] === "(") { i = closingParen(text, i + 2); if (i < 0) return -1; }
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "#" && /^$|\s/.test(text[i - 1] ?? "")) { const nl = text.indexOf("\n", i); i = nl < 0 ? text.length : nl; }
    else if (wordAt(text, i, "case")) cases++;
    else if (wordAt(text, i, "esac") && cases > 0) cases--;
    else if (c === "(") open++;
    else if (c === ")" && !(open === 1 && cases > 0) && --open === 0) return i;
  }
  return -1;
}

function closingBacktick(text: string, i: number): number {
  for (; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "`") return i;
  }
  return -1;
}

/** Index of the `}` closing a `${` opened just before `i`, or -1. */
function closingBrace(text: string, i: number): number {
  let open = 1;
  let quote: string | null = null;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") { if (c === "'") quote = null; continue; }
    if (c === "\\") { i++; continue; }
    if (quote === '"') { if (c === '"') quote = null; continue; }
    if (c === "'" || c === '"') quote = c;
    else if (c === "{") open++;
    else if (c === "}" && --open === 0) return i;
  }
  return -1;
}

/** Index of the `}` word closing a `{ group` whose body starts at `i`, or -1:
 *  a `}` at a command position, after `;`, `&` or a newline. */
function closingGroup(text: string, i: number): number {
  let open = 1;
  let quote: string | null = null;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") { if (c === "'") quote = null; continue; }
    if (c === "\\") { i++; continue; }
    if (quote === '"') { if (c === '"') quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "(") { const close = closingParen(text, i + 1); if (close < 0) return -1; i = close; continue; }
    if (c === "{" && /\s/.test(text[i + 1] ?? "") && /(^|[\s;&|({])$/.test(text.slice(0, i))) open++;
    else if (c === "}" && /[;&\n][ \t]*$/.test(text.slice(0, i)) && --open === 0) return i;
  }
  return -1;
}

/** Deepest unquoted paren nesting in `text` (single-quoted and escaped parens do not count). */
function parenDepth(text: string): number {
  let depth = 0, deepest = 0, single = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (single) { if (c === "'") single = false; continue; }
    if (c === "'") single = true;
    else if (c === "\\") i++;
    else if (c === "(") deepest = Math.max(deepest, ++depth);
    else if (c === ")") depth = Math.max(0, depth - 1);
  }
  return deepest;
}

/**
 * Read the expansion that starts at `i` (`$((…))`, `$(…)`, a backtick, `${…}`)
 * into `split`: its commands to `bodies`, its placeholder to `line`. Returns
 * the index of its last character, null when no expansion starts at `i`, or -1
 * when it cannot be read (`split.unreadable` says why).
 */
function readExpansion(text: string, i: number, split: NestedSplit): number | null {
  const c = text[i], next = text[i + 1];
  if (c === "`") {
    const close = closingBacktick(text, i + 1);
    if (close < 0) { split.unreadable = "a backtick substitution is not closed"; return -1; }
    const body = text.slice(i + 1, close).replace(/\\([`\\$])/g, "$1");
    split.bodies.push(body);
    split.line += placeholderFor(body);
    return close;
  }
  if (c !== "$" || (next !== "(" && next !== "{")) return null;
  // `$((` is arithmetic only if it closes as arithmetic (arithmeticSpanEnd):
  // `$(( (cmd) ) )` is a command substitution of a subshell.
  const arithmeticEnd = next === "(" ? arithmeticSpanEnd(text, i) : -1;
  const close = arithmeticEnd > 0 ? arithmeticEnd - 1 : next === "(" ? closingParen(text, i + 2) : closingBrace(text, i + 2);
  if (close < 0) { split.unreadable = `a ${c}${next} expansion is not closed`; return -1; }
  const inner = text.slice(i + 2, close);
  if (next === "(" && arithmeticEnd < 0) {
    split.bodies.push(inner);
    split.line += placeholderFor(inner);
  } else if (next === "{" && /^[\s|]/.test(inner)) {
    split.bodies.push(inner.replace(/^\|/, ""));
    split.line += NESTED_OUTPUT;
  } else {
    // Arithmetic `$((…))` or a parameter `${…}`: no command of its own, but
    // either can hold a substitution (`${dir:-$(pwd)}`).
    const nested = expansionsIn(inner);
    if (nested.length === 0) split.line += text.slice(i, close + 1);
    else { split.bodies.push(...splitNestedCommands(nested.join(" ")).bodies); split.line += NESTED_OUTPUT; }
  }
  return close;
}

/** Take the nested commands out of a command line (see the header). */
export function splitNestedCommands(command: string): NestedSplit {
  const split: NestedSplit = { line: "", bodies: [] };
  if (parenDepth(command) > MAX_NESTING) {
    split.unreadable = `parentheses are nested more than ${MAX_NESTING} deep`;
    return split;
  }
  let quote: string | null = null;
  let atCommand = true;
  let word = "";
  let lastWord = "";
  const endWord = () => {
    if (!word) return;
    // A `case` pattern (`a)`, `*.txt)`) is followed by the command it selects.
    if (COMMAND_KEYWORDS.has(word) || lastWord === "function" || word.endsWith(")")) atCommand = true;
    lastWord = word;
    word = "";
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") { split.line += c; if (c === "'") quote = null; continue; }
    if (c === "\\") { split.line += command.slice(i, i + 2); i++; word += "\\"; atCommand = false; continue; }
    const expansion = readExpansion(command, i, split);
    if (expansion !== null) {
      if (expansion < 0) return split;
      i = expansion; word += "$"; atCommand = false;
      continue;
    }
    if (quote === '"') { split.line += c; if (c === '"') quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; split.line += c; word += c; atCommand = false; continue; }
    if (c === "#" && !word) {
      const nl = command.indexOf("\n", i);
      const end = nl < 0 ? command.length : nl;
      split.line += command.slice(i, end);
      i = end - 1;
      continue;
    }
    if ((c === "<" || c === ">") && command[i + 1] === "(") {
      const close = closingParen(command, i + 2);
      if (close < 0) { split.unreadable = `a ${c}( process substitution is not closed`; return split; }
      split.bodies.push(command.slice(i + 2, close));
      split.line += NESTED_OUTPUT;
      i = close; atCommand = false;
      continue;
    }
    if (c === "(" && word && command[i + 1] === ")") {
      // `name()`: a function definition; its body is the command that follows.
      split.line += "()"; i++; endWord(); atCommand = true;
      continue;
    }
    if (c === "(" && atCommand) {
      const close = closingParen(command, i + 1);
      if (close < 0) { split.unreadable = "a ( subshell ) is not closed"; return split; }
      const inner = command.slice(i + 1, close);
      // `(( … ))` at a command position is arithmetic, not a subshell.
      if (arithmeticSpanEnd(command, i) === close + 1) {
        const nested = expansionsIn(inner);
        if (nested.length === 0) split.line += command.slice(i, close + 1);
        else { split.bodies.push(...splitNestedCommands(nested.join(" ")).bodies); split.line += ":"; }
      } else {
        split.bodies.push(inner);
        split.line += ":";
      }
      i = close; atCommand = false;
      continue;
    }
    if (c === "{" && atCommand && !word && /\s/.test(command[i + 1] ?? "")) {
      const close = closingGroup(command, i + 1);
      if (close < 0) { split.unreadable = "a { group } is not closed"; return split; }
      split.bodies.push(command.slice(i + 1, close));
      split.line += ":";
      i = close; atCommand = false;
      continue;
    }
    split.line += c;
    if (/\s/.test(c)) {
      endWord();
      if (c === "\n") atCommand = true;
    } else if (";&|".includes(c)) {
      endWord(); lastWord = ""; atCommand = true;
    } else {
      word += c;
      atCommand = false;
    }
  }
  return split;
}

/**
 * The expansions bash runs while expanding text with no quoting of its own (an
 * unquoted heredoc body, an arithmetic or parameter expression): each `$(…)`,
 * backtick and `${ …; }`, verbatim. Text that cannot be balanced is returned
 * whole from where it starts, so a caller that judges the result refuses it.
 */
export function expansionsIn(text: string): string[] {
  const found: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") { i++; continue; }
    if (c !== "`" && !(c === "$" && (text[i + 1] === "(" || text[i + 1] === "{"))) continue;
    const probe: NestedSplit = { line: "", bodies: [] };
    const close = readExpansion(text, i, probe);
    if (close === null) continue;
    if (close < 0) { found.push(text.slice(i)); break; }
    if (probe.bodies.length > 0) found.push(text.slice(i, close + 1));
    i = close;
  }
  return found;
}

/** Does a command whose words are `words` take its program from a nested
 *  command? (A line of assignments only, `arch=$NESTED_OUTPUT`, runs none.) */
export function runsNestedOutput(words: string[]): boolean {
  const at = resolveRealArgv0Index(words);
  return at !== null && (words[at].includes(NESTED_OUTPUT) || words[at].includes(ENVIRONMENT_SETUP_OUTPUT));
}

