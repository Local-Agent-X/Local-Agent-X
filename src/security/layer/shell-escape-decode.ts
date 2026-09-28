// What the shell (or the command it hands the text to) makes of a command's
// escape sequences, so the rules judge the command that would RUN instead of
// refusing on the sight of an escape. The old raw-string rule refused any
// `\xNN` anywhere — in a `sed 's/\x1b\[[0-9;]*m//g'` that strips ANSI color
// codes from test output as readily as in a hidden `rm`.
//
// `$'…'` (ANSI-C quoting) is decoded by bash itself: \xHH, \uHHHH, \NNN octal
// and the C escapes. A bare \xHH / \uHHHH outside it is decoded too: bash
// leaves it alone, but echo -e, printf, sed and tr read it, so the decoded
// view over-approximates in the safe direction — a command word that only
// exists once the escapes are read is still a command word. A bare \NNN is
// left alone on purpose: it is a Windows path (`C:\reports\2024`) far more
// often than an octal escape, and nothing reads it as one outside $'…'.

const ANSI_C_SPAN = /\$'((?:[^'\\]|\\.)*)'/g;
const ANSI_C_ESCAPE = /\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|[0-7]{1,3}|.)/g;
const BARE_ESCAPE = /\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4})/g;
const C_ESCAPES: Record<string, string> = {
  n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v", e: "\x1b", E: "\x1b",
  "\\": "\\", "'": "'", '"': '"', "?": "?",
};

function decodeAnsiC(body: string): string {
  return body.replace(ANSI_C_ESCAPE, (whole, esc: string) => {
    if ((esc[0] === "x" || esc[0] === "u") && esc.length > 1) return String.fromCharCode(parseInt(esc.slice(1), 16));
    if (/^[0-7]/.test(esc)) return String.fromCharCode(parseInt(esc, 8));
    return C_ESCAPES[esc] ?? whole;
  });
}

// A decoded `$'…'` becomes a plain word when it is one, so `$'\x72\x6d' -rf /`
// reads `rm -rf /` to every rule that reads words; anything else stays quoted.
function asWord(decoded: string): string {
  return /^[\w./:@%+=,-]+$/.test(decoded) ? decoded : `'${decoded.replace(/'/g, "")}'`;
}

/** The command with its escape sequences read; identical to the input when it
 *  has none. A `$'…'` body is read all the way down (`$'\x5cx72'` spells
 *  `\x72`, which spells `r`), so the word it finally spells is the word judged. */
export function decodeShellEscapes(command: string): string {
  return command
    .replace(ANSI_C_SPAN, (_, body: string) => asWord(decodeShellEscapes(decodeAnsiC(body))))
    .replace(BARE_ESCAPE, (_, esc: string) => String.fromCharCode(parseInt(esc.slice(1), 16)));
}
