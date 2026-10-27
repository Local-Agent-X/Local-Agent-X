// What bash does to a command's text before it runs any of it, so the shell
// rules judge the command line bash parses, not the raw text the model sent.
//
// - A backslash-newline outside single quotes and comments is a line
//   continuation: bash deletes both characters. `apt-get install -y \⏎ curl`
//   is one command, and `curl` on its second line is an argument. A denylist
//   entry used to refuse every continuation, which refused every multi-line
//   install command (13 of 89 Terminal-Bench 2.0 reference solutions).
// - A heredoc body is the command's input, not part of its command line. Read
//   as commands, a C file's `(` was a subshell and a Python file's
//   `requests.get` a shell network call. What the body is depends on what
//   reads it: a shell runs it as a script, so it comes back as a script to be
//   judged like any command; an interpreter runs it as a program, so it stays
//   on the line as one quoted word, where the rules that read program text
//   still read it; anything else (cat, tee, a database client) takes data.
//   Under an unquoted delimiter bash still runs the body's `$(…)` and
//   backticks, so those stay on the line, where the nested-command rules see
//   them.

import { commandPositions } from "./shell-command-positions.js";
import { expansionsIn } from "./shell-nested-commands.js";
import { resolveRealArgv0 } from "./shell-lex.js";

export interface SourceText {
  /** The command line bash parses: continuations joined, heredoc bodies out. */
  command: string;
  /** Heredoc bodies a shell will run, each to be judged as a command. */
  scripts: string[];
  /** Heredoc bodies a language interpreter runs as its program (`python3 -
   *  <<'EOF'`): read like a `-c` program's text for the destinations its
   *  network calls name (shell-inline-destinations.ts). */
  programs: string[];
}

/** Interpreters whose stdin program the destination reader can read. */
const LANGUAGES = new Set(["python", "perl", "ruby", "node", "php", "deno", "bun"]);

interface Heredoc { delimiter: string; quoted: boolean; stripTabs: boolean; body: string }

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash", "fish", "source", "."]);
const INTERPRETERS = new Set([
  "python", "perl", "ruby", "node", "php", "deno", "bun", "pwsh", "powershell", "cmd", "xargs",
]);

const marker = (n: number) => `LAXHEREDOC${n}`;

/** The delimiter word at `i` (after `<<` / `<<-`): its text, whether any of it
 *  was quoted, and the index after it. */
function readDelimiter(text: string, i: number): { word: string; quoted: boolean; end: number } {
  while (text[i] === " " || text[i] === "\t") i++;
  let word = "";
  let quoted = false;
  let quote: string | null = null;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = null; else word += c; continue; }
    if (c === "'" || c === '"') { quote = c; quoted = true; continue; }
    if (c === "\\") { quoted = true; word += text[++i] ?? ""; continue; }
    if (/[\s;&|<>()]/.test(c)) break;
    word += c;
  }
  return { word, quoted, end: i };
}

/** Read the bodies of `pending` from the line after index `i` (a newline).
 *  Returns the index of the last character consumed. */
function readBodies(text: string, i: number, pending: Heredoc[]): number {
  for (const doc of pending) {
    const lines: string[] = [];
    while (i < text.length) {
      const nl = text.indexOf("\n", i + 1);
      const end = nl < 0 ? text.length : nl;
      const line = text.slice(i + 1, end).replace(/\r$/, "");
      i = end;
      if ((doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) break;
      lines.push(doc.stripTabs ? line.replace(/^\t+/, "") : line);
    }
    doc.body = lines.join("\n");
  }
  return i;
}

/** Walk the text as bash reads it: join continuations, cut heredoc bodies out,
 *  leave a marker where each heredoc operator was. */
function walk(text: string): { line: string; heredocs: Heredoc[] } {
  let line = "";
  const heredocs: Heredoc[] = [];
  let pending: Heredoc[] = [];
  let quote: string | null = null;
  let arithmetic = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") { line += c; if (c === "'") quote = null; continue; }
    if (c === "\\") {
      if (text[i + 1] === "\n") { i++; continue; }
      if (text[i + 1] === "\r" && text[i + 2] === "\n") { i += 2; continue; }
      line += text.slice(i, i + 2); i++;
      continue;
    }
    if (quote === '"') { line += c; if (c === '"') quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; line += c; continue; }
    if (c === "#" && /^$|[\s;&|(]/.test(text[i - 1] ?? "")) {
      // A comment runs to the end of the line; a backslash there is not a continuation.
      const nl = text.indexOf("\n", i);
      const end = nl < 0 ? text.length : nl;
      line += text.slice(i, end);
      i = end - 1;
      continue;
    }
    // `<<` inside `$(( ))` / `(( ))` is a left shift, not a heredoc.
    if (c === "(" && text[i + 1] === "(") { arithmetic++; line += "(("; i++; continue; }
    if (c === ")" && text[i + 1] === ")" && arithmetic > 0) { arithmetic--; line += "))"; i++; continue; }
    if (c === "<" && text[i + 1] === "<" && arithmetic === 0) {
      if (text[i + 2] === "<") { line += "<<<"; i += 2; continue; }
      const stripTabs = text[i + 2] === "-";
      const d = readDelimiter(text, i + (stripTabs ? 3 : 2));
      if (d.word) {
        const doc: Heredoc = { delimiter: d.word, quoted: d.quoted, stripTabs, body: "" };
        line += `<<${marker(heredocs.length)}`;
        heredocs.push(doc);
        pending.push(doc);
        i = d.end - 1;
        continue;
      }
    }
    if (c === "\n" && pending.length > 0) {
      line += c;
      i = readBodies(text, i, pending);
      pending = [];
      continue;
    }
    line += c;
  }
  return { line, heredocs };
}

/** What reads each heredoc: the command it is attached to and every command it
 *  pipes into. A shell anywhere in that chain runs it; failing that, an
 *  interpreter does; otherwise it is data. A heredoc whose command cannot be
 *  found is judged as a script. "program" is an interpreter whose every
 *  reader in the chain is a language (LANGUAGES), not `xargs` or `cmd`. */
function readers(line: string, count: number): Array<"shell" | "interpreter" | "program" | "data"> {
  const kinds: Array<"shell" | "interpreter" | "program" | "data"> = new Array(count).fill("shell");
  const positions = commandPositions(line).positions.filter((p) => p.depth === 0);
  positions.forEach((p, idx) => {
    for (const r of p.redirections) {
      const m = /^LAXHEREDOC(\d+)/.exec(r.target);
      if (r.op !== "<<" || !m) continue;
      const chain = [p];
      for (let j = idx + 1; j < positions.length && positions[j].piped; j++) chain.push(positions[j]);
      const bins = chain.map((q) => readerBin(q.words));
      const interpreters = bins.filter((b) => INTERPRETERS.has(b!));
      kinds[Number(m[1])] = bins.some((b) => b === null || SHELLS.has(b)) ? "shell"
        : interpreters.length === 0 ? "data"
        : interpreters.every((b) => LANGUAGES.has(b!)) ? "program" : "interpreter";
    }
  });
  return kinds;
}

/** The program that reads a command's stdin, past an assignment, `(`, `{`, `!`
 *  and wrappers; null when the program is computed at run time, which fails
 *  closed as a shell. */
function readerBin(words: string[]): string | null {
  const bin = resolveRealArgv0(words.map((w) => w.replace(/^(?:[A-Za-z_]\w*=(?=\$\())?(?:\$\(|[<>]\(|[({!`])+/, "")).filter(Boolean));
  return bin === null || /[$`]/.test(bin) ? null : bin;
}

/** Read `command` as bash does before running it (see the header). */
export function readSourceText(command: string): SourceText {
  const { line, heredocs } = walk(command);
  if (heredocs.length === 0) return { command: line, scripts: [], programs: [] };
  const kinds = readers(line, heredocs.length);
  const scripts: string[] = [];
  const programs: string[] = [];
  const rebuilt = line.replace(/<<LAXHEREDOC(\d+)/g, (_, n: string) => {
    const doc = heredocs[Number(n)];
    const kind = kinds[Number(n)];
    let words = `<<${doc.quoted ? `'${doc.delimiter}'` : doc.delimiter}`;
    if (kind === "shell") scripts.push(doc.body);
    if (kind === "program") programs.push(doc.body);
    if (kind === "interpreter" || kind === "program") words += ` '${doc.body.replace(/'/g, '"')}'`;
    if (!doc.quoted && kind !== "shell") for (const e of expansionsIn(doc.body)) words += ` ${e}`;
    return words;
  });
  return { command: rebuilt, scripts, programs };
}
