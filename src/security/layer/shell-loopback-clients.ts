/**
 * The loopback destination a shell network client reaches, when that is all
 * it reaches: `curl localhost:8080/health`, `ssh -p 2222 root@localhost`,
 * `nc -z 127.0.0.1 5432`, `socat - UNIX-CONNECT:/tmp/qemu.sock`. The network
 * rule (shell-command-rule-table.ts) refuses these clients because a host
 * shell can reach any host; a client that names only this machine reaches no
 * farther than http_request may, and the rule lets it through on the same
 * grant (loopback-grant.ts). Checking that a server the agent started answers
 * is most of what these commands are for.
 *
 * Fails closed: an operand this cannot read as a loopback destination, a
 * second host, or a flag that would send the client somewhere else (a proxy,
 * a tunnel, a redirect to follow, a config or URL file) means the client
 * reaches more than it names, and null is returned.
 */
import type { CommandPosition } from "./shell-command-positions.js";
import { isLoopbackHost } from "./ip-classification.js";
import { defaultPort } from "./loopback-grant.js";

export interface LoopbackUse {
  /** The loopback ports connected to. */
  ports: string[];
  /** The Unix socket paths connected to. */
  unixSockets: string[];
  /** A connect-only check (`nc -z`): nothing is sent, so any port may be checked. */
  probe: boolean;
}

const RAW_TCP_CLIENTS = new Set(["nc", "ncat", "nc.traditional", "netcat", "telnet"]);
const HTTP_CLIENTS = new Set(["curl", "wget", "xh", "http", "https", "httpie", "curlie", "aria2c", "fetch", "websocat"]);
const SSH_CLIENTS = new Set(["ssh", "scp", "sftp"]);

/** What a client command reaches, or null when it is not only loopback. */
export function loopbackUse(p: CommandPosition): LoopbackUse | null {
  // An environment proxy reroutes every client: `http_proxy=x curl …`.
  if (p.words.slice(0, p.at).some((w) => /proxy/i.test(w))) return null;
  const args = p.words.slice(p.at + 1);
  if (RAW_TCP_CLIENTS.has(p.bin)) return rawTcpUse(p.bin, args);
  if (HTTP_CLIENTS.has(p.bin)) return httpClientUse(p.bin, args);
  if (SSH_CLIENTS.has(p.bin)) return sshClientUse(p.bin, args);
  if (p.bin === "socat") return socatUse(args);
  return null;
}

const loopback = (host: string) => isLoopbackHost(host.replace(/^\[|\]$/g, "").toLowerCase());
const isPort = (s: string) => /^\d{1,5}$/.test(s);
const only = (ports: string[], probe = false): LoopbackUse => ({ ports, unixSockets: [], probe });

// ── nc / ncat / telnet: `nc [-z] HOST PORT` ──
// Listening, running a program on the socket and a proxy hop reach past the port.
const RAW_TCP_REROUTE = /^-[a-zA-Z]*[lecxX]|^--(?:listen|exec|sh-exec|lua-exec|proxy)/;

function rawTcpUse(bin: string, args: string[]): LoopbackUse | null {
  if (args.some((a) => RAW_TCP_REROUTE.test(a))) return null;
  const operands = args.filter((a) => !a.startsWith("-"));
  const at = operands.findIndex((a) => !isPort(a) && loopback(a));
  if (at < 0 || operands.slice(0, at).some((a) => !isPort(a))) return null;
  const rest = operands.slice(at + 1);
  if (rest.length > 1 || rest.some((a) => !isPort(a))) return null;
  const port = rest[0] ?? (bin === "telnet" ? "23" : null);
  if (port === null) return null;
  return only([port], args.some((a) => /^-[a-zA-Z]*z/.test(a)));
}

// ── curl, wget and the other HTTP clients: URL operands ──
// Flags that take a value, so the value is never read as an operand.
const CURL_VALUE_FLAGS = new Set([
  "-d", "-H", "-X", "-o", "-w", "-m", "-u", "-A", "-b", "-c", "-e", "-F", "-T", "-U", "-y", "-z", "-E", "-Y", "-r", "-t", "-C", "-D", "-Q",
  "--data", "--data-raw", "--data-binary", "--data-urlencode", "--json", "--header", "--request", "--output", "--write-out",
  "--max-time", "--connect-timeout", "--retry", "--retry-delay", "--retry-max-time", "--user", "--user-agent", "--cookie",
  "--cookie-jar", "--referer", "--form", "--form-string", "--upload-file", "--cert", "--key", "--cacert", "--range",
]);
const WGET_VALUE_FLAGS = new Set([
  "-O", "-o", "-a", "-T", "-t", "-w", "-P", "-U", "--output-document", "--output-file", "--append-output", "--timeout",
  "--tries", "--wait", "--directory-prefix", "--user-agent", "--header", "--post-data", "--post-file", "--user",
  "--password", "--body-data", "--body-file", "--method",
]);
// Flags that send the client somewhere the operands do not say.
const HTTP_REROUTE = /^--(?:proxy|socks|connect-to|resolve|unix-socket|abstract-unix-socket|interface|dns-|location|config|conf|execute|input-file|all-proxy|http-proxy|https-proxy)/;
const CURL_REROUTE_SHORT = new Set(["-x", "-K", "-L"]);
const WGET_REROUTE_SHORT = new Set(["-e", "-i"]);

function httpClientUse(bin: string, args: string[]): LoopbackUse | null {
  const valueFlags = bin === "wget" ? WGET_VALUE_FLAGS : CURL_VALUE_FLAGS;
  const rerouteShort = bin === "wget" ? WGET_REROUTE_SHORT : CURL_REROUTE_SHORT;
  const ports: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-")) {
      if (HTTP_REROUTE.test(a) || rerouteShort.has(a) || /^-[a-zA-Z]*[xKL][a-zA-Z]*$/.test(a) && bin === "curl") return null;
      if (valueFlags.has(a)) i++;
      continue;
    }
    if (!/^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:localhost|[\w.-]*\.[\w.-]+|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\])(?::\d+)?(?:[/?#]|$)/i.test(a)) continue;
    let url: URL;
    try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(a) ? a : `http://${a}`); } catch { return null; }
    if (!loopback(url.hostname)) return null;
    ports.push(url.port || defaultPort(url.protocol));
  }
  return ports.length > 0 ? only(ports) : null;
}

// ── ssh / scp / sftp: `[user@]host`, `-p`/`-P PORT` ──
const SSH_VALUE_FLAGS = new Set(["-p", "-P", "-l", "-i", "-o", "-F", "-E", "-b", "-c", "-e", "-I", "-m", "-O", "-Q", "-S", "-w", "-B"]);
// Tunnels and jump hosts reach past the host named.
const SSH_REROUTE = new Set(["-L", "-R", "-D", "-J", "-W"]);
const SSH_OPTION_REROUTE = /proxy|forward|tunnel|jump|gateway/i;

function sshClientUse(bin: string, args: string[]): LoopbackUse | null {
  let port: string | null = null;
  const hosts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-")) {
      if (SSH_REROUTE.has(a) || /^-[a-zA-Z]*[LRDJW]/.test(a)) return null;
      if (a === "-o" && SSH_OPTION_REROUTE.test(args[i + 1] ?? "")) return null;
      if (a === "-p" || a === "-P") port = args[i + 1] ?? null;
      if (SSH_VALUE_FLAGS.has(a)) i++;
      continue;
    }
    if (bin === "ssh") { hosts.push(a); break; } // the rest is the remote command
    const m = /^(?:[^@/:]+@)?(\[[^\]]+\]|[^:/]+):/.exec(a); // scp/sftp: host:path
    if (m) hosts.push(m[1]); else if (bin === "sftp" && hosts.length === 0) hosts.push(a);
  }
  if (hosts.length === 0 || port !== null && !isPort(port)) return null;
  const names = hosts.map((h) => h.replace(/^[^@]*@/, ""));
  if (!names.every(loopback)) return null;
  return only([port ?? "22"]);
}

// ── socat: two addresses, each read as what it connects to ──
const SOCAT_VALUE_FLAGS = new Set(["-t", "-T", "-b", "-l", "-L", "-r", "-R", "-S", "-I"]);
const STDIO_ADDRESS = new Set(["-", "STDIO", "STDIN", "STDOUT", "STDERR"]);
const UNIX_CONNECT = new Set(["UNIX-CONNECT", "UNIX-CLIENT", "UNIX", "ABSTRACT-CONNECT"]);
const TCP_CONNECT = new Set(["TCP", "TCP4", "TCP6", "TCP-CONNECT", "OPENSSL", "SSL"]);

function socatUse(args: string[]): LoopbackUse | null {
  const use: LoopbackUse = { ports: [], unixSockets: [], probe: false };
  const addresses: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("-") && args[i] !== "-") { if (SOCAT_VALUE_FLAGS.has(args[i])) i++; continue; }
    addresses.push(args[i]);
  }
  if (addresses.length !== 2) return null;
  for (const address of addresses) {
    const [spec, ...options] = address.split(",");
    if (options.some((o) => /proxy|socks|exec|system|bind|range/i.test(o))) return null;
    const colon = spec.indexOf(":");
    const type = (colon < 0 ? spec : spec.slice(0, colon)).toUpperCase();
    const rest = colon < 0 ? "" : spec.slice(colon + 1);
    if (STDIO_ADDRESS.has(type)) continue;
    if (UNIX_CONNECT.has(type) && rest) { use.unixSockets.push(rest); continue; }
    const m = TCP_CONNECT.has(type) ? /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(rest) : null;
    if (!m || !loopback(m[1])) return null;
    use.ports.push(m[2]);
  }
  return use.ports.length + use.unixSockets.length > 0 ? use : null;
}
