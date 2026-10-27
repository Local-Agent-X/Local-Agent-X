/**
 * The network destinations an inline program names: the `python3 -c "…"` /
 * `node -e "…"` bodies of a command, read for the hosts, ports and socket
 * paths their network calls spell out as literals. The inline-network scan
 * (shell-detectors.ts detectInlineNetwork, and the HTTP-library text patterns
 * in shell-rules.ts) refuses a program for using the network at all; a
 * program whose every destination is a literal this machine's own (a loopback
 * port the shell may reach, a Unix socket) reaches no farther than a shell
 * client to the same place, so the scan stands down for it on the same grant
 * (loopback-grant.ts). Talking to a service's control socket or checking a
 * local port from a few lines of Python is ordinary work.
 *
 * Fails closed: a call whose destination is not a plain literal (a variable,
 * an f-string, a computed tuple), any literal that is not loopback, or a
 * program that uses the network without naming a destination this can read,
 * is "unknown", and the scan refuses it as before.
 */
import { commandPositions } from "./shell-command-positions.js";
import { INTERP_EVAL_FLAGS } from "./shell-rules.js";
import { isLoopbackHost } from "./ip-classification.js";
import { defaultPort } from "./loopback-grant.js";

export type InlineDestinations =
  | { kind: "none" }
  | { kind: "local"; ports: string[]; unixSockets: string[] }
  | { kind: "unknown" };

/** The inline programs of a command: each argument that follows an eval flag. */
export function inlinePrograms(command: string): string[] {
  const programs: string[] = [];
  for (const p of commandPositions(command).positions) {
    const flags = INTERP_EVAL_FLAGS[p.bin];
    if (!flags) continue;
    const args = p.words.slice(p.at + 1);
    args.forEach((a, i) => { if (i > 0 && flags.has(args[i - 1])) programs.push(a); });
  }
  return programs;
}

// A call that takes a destination, followed by what it is given. Group 1 is
// the argument text up to the first close paren of the call.
const DESTINATION_CALL =
  /(?:\b(?:connect_ex|connect|create_connection|urlopen|fetch|createConnection|HTTPConnection|HTTPSConnection|Request)|requests\.(?:get|post|put|patch|delete|head|request)|TCPSocket\.(?:new|open))\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
const STRING = `(?:'([^'\\\\]*)'|"([^"\\\\]*)")`;
const TUPLE = new RegExp(`^\\s*\\(\\s*${STRING}\\s*,\\s*(\\d{1,5})\\s*,?\\s*\\)\\s*(?:,|$)`);
const PORT_HOST = new RegExp(`^\\s*(\\d{1,5})\\s*,\\s*${STRING}`);
const HOST_PORT = new RegExp(`^\\s*${STRING}\\s*,\\s*(\\d{1,5})\\s*(?:,|$)`);
const OBJECT = /^\s*\{([^}]*)\}\s*$/;
const ONLY_STRING = new RegExp(`^\\s*${STRING}\\s*(?:,|$)`);
const IDENTIFIER = /^\s*([A-Za-z_]\w*)\s*(?:,|$)/;
const URL_LITERAL = /^[a-z][a-z0-9+.-]*:\/\//i;

const literal = (m: RegExpMatchArray, a: number, b: number) => m[a] ?? m[b];
const loopback = (host: string) => isLoopbackHost(host.replace(/^\[|\]$/g, "").toLowerCase());

/** A name bound exactly once in the program to a literal or a Request of
 *  one (`url = 'http://localhost:8080'`, `req = Request('…', method='GET')`),
 *  so a call handed the name is handed that literal. Bound twice, or to
 *  anything else: unknown. */
function bindings(program: string): Map<string, string | null> {
  const bound = new Map<string, string | null>();
  for (const m of program.matchAll(/(?:^|[;\n])\s*([A-Za-z_]\w*)\s*=\s*([^\n;]*)/g)) {
    const [, name, value] = m;
    const lit = new RegExp(`^\\s*(?:(?:urllib\\.request\\.)?Request\\s*\\(\\s*)?${STRING}`).exec(value);
    bound.set(name, bound.has(name) || !lit ? null : literal(lit, 1, 2));
  }
  return bound;
}

/** Where one call's argument text points, or null when it cannot be read. */
function destinationOf(argText: string, bound: Map<string, string | null>): { port: string } | { unixSocket: string } | null {
  let m: RegExpMatchArray | null;
  if ((m = IDENTIFIER.exec(argText))) {
    const value = bound.get(m[1]);
    return value ? destinationOf(`'${value}'`, bound) : null;
  }
  if ((m = TUPLE.exec(argText))) return loopback(literal(m, 1, 2)) ? { port: m[3] } : null;
  if ((m = PORT_HOST.exec(argText))) return loopback(literal(m, 2, 3)) ? { port: m[1] } : null;
  if ((m = HOST_PORT.exec(argText))) return loopback(literal(m, 1, 2)) ? { port: m[3] } : null;
  if ((m = OBJECT.exec(argText))) {
    const host = /\bhost(?:name)?\s*:\s*(?:'([^']*)'|"([^"]*)")/.exec(m[1]);
    const port = /\bport\s*:\s*(\d{1,5})/.exec(m[1]);
    const path = /\bpath\s*:\s*(?:'([^']*)'|"([^"]*)")/.exec(m[1]);
    if (path) return { unixSocket: path[1] ?? path[2] };
    return host && port && loopback(host[1] ?? host[2]) ? { port: port[1] } : null;
  }
  if ((m = ONLY_STRING.exec(argText))) {
    const s = literal(m, 1, 2);
    if (s.startsWith("/")) return { unixSocket: s };
    if (!URL_LITERAL.test(s)) return null;
    try {
      const url = new URL(s);
      return loopback(url.hostname) ? { port: url.port || defaultPort(url.protocol) } : null;
    } catch { return null; }
  }
  return null;
}

/** The destinations every inline program of `command` names (see the header),
 *  and those of `heredocPrograms`, the bodies a heredoc feeds an interpreter
 *  as its program (shell-source-text.ts `programs`). */
export function inlineProgramDestinations(command: string, heredocPrograms: readonly string[] = []): InlineDestinations {
  const ports: string[] = [];
  const unixSockets: string[] = [];
  let calls = 0;
  for (const program of [...inlinePrograms(command), ...heredocPrograms]) {
    const bound = bindings(program);
    for (const m of program.matchAll(DESTINATION_CALL)) {
      calls++;
      const d = destinationOf(m[1], bound);
      if (!d) return { kind: "unknown" };
      if ("port" in d) ports.push(d.port); else unixSockets.push(d.unixSocket);
    }
  }
  if (calls === 0) return { kind: "none" };
  return { kind: "local", ports: [...new Set(ports)], unixSockets: [...new Set(unixSockets)] };
}
