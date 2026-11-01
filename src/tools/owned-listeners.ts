/**
 * The loopback ports held by processes THIS harness spawned through
 * process_start — a dependency-free leaf (node:child_process only) the security
 * layer folds into its local-service ports, the same way it folds in the
 * dev-server record store (dev-server-records.ts, and for the same reason: the
 * layer cannot import process-session.ts without a cycle). On Linux the
 * listeners and the process table come from /proc (no lsof or ps, which a
 * minimal container lacks); the port-holder lookup (process-session.ts
 * pidsOnPort) reads the same table.
 *
 * Evidence, not configuration: a port is reachable because a process the
 * agent started (or a descendant of it — `npm run dev` forks the server that
 * actually binds) is listening on it, for exactly as long as it runs. On
 * 2026-09-25 the agent started `langgraph dev` and was then refused
 * `http://127.0.0.1:2024/ok` seventeen times as a "private/reserved IPv4
 * address", with a recovery that told it to edit security.json — a file it
 * may not touch. Ports only, never a host: the loopback-host gate in
 * network-policy still decides WHERE a port may be dialed.
 *
 * The Unix sockets those processes listen on are theirs on the same evidence
 * (ownedUnixSockets): `qemu -serial unix:/tmp/vm.sock,server` started by the
 * agent is its console, while docker.sock, an ssh-agent or the session bus,
 * which no process the agent started holds, stay out of reach.
 *
 * A server a shell command backgrounded (`node server.js &`, `qemu … &`) is
 * reparented to init once the shell exits, and the parent chain loses it.
 * The shell tool spawns each shell detached, leading its own process group,
 * and registers the group (registerOwnedGroup): a listener in that group is
 * the agent's for as long as any process holds the group. A daemon that
 * calls setsid() leaves the group and is not proven; a reused pid is not the
 * shell (liveGroups).
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";

export interface Listener { port: number; pid: number }
/** `pgid`: the process group, where the table reports it (Linux, macOS). */
export interface Proc { pid: number; ppid: number; pgid?: number }
export interface SocketListener { path: string; pid: number }

const ownedPids = new Set<number>();
// The process groups the agent's shells led (shell-tool.ts spawns each
// detached): a server a shell backgrounded keeps the group once the shell
// exits and init adopts it, where the parent chain would have lost it.
const ownedGroups = new Set<number>();
const GROUPS_CAP = 1024;
let cache: { at: number; ports: Set<string> } | null = null;
let socketCache: { at: number; paths: Set<string> } | null = null;
const CACHE_MS = 3000;

export function registerOwnedProcess(pid: number | null | undefined): void {
	if (typeof pid === "number" && pid > 0) {
		ownedPids.add(pid);
		cache = null;
		socketCache = null;
	}
}

export function unregisterOwnedProcess(pid: number | null | undefined): void {
	if (typeof pid === "number") {
		ownedPids.delete(pid);
		cache = null;
		socketCache = null;
	}
}

/** A shell the agent ran leads process group `pid` (spawned detached). Kept
 *  until no live process is in the group; the oldest go once the cap is hit. */
export function registerOwnedGroup(pid: number | null | undefined): void {
	if (typeof pid !== "number" || pid <= 0) return;
	ownedGroups.add(pid);
	for (const g of ownedGroups) { if (ownedGroups.size <= GROUPS_CAP) break; ownedGroups.delete(g); }
	cache = null;
	socketCache = null;
}

/** The groups still held by a live process. A group whose id a live process
 *  carries as its pid but not as its group is a reused pid, not the shell. */
export function liveGroups(groups: ReadonlySet<number>, procs: readonly Proc[]): Set<number> {
	const held = new Set(procs.map((p) => p.pgid));
	const reused = new Set(procs.filter((p) => p.pgid !== undefined && p.pgid !== p.pid).map((p) => p.pid));
	return new Set([...groups].filter((g) => held.has(g) && !reused.has(g)));
}

/** Is `pid` one of `owned`, a descendant of one, or in one of `groups`, by the `procs` table? */
function ownedBy(procs: readonly Proc[], owned: ReadonlySet<number>, groups: ReadonlySet<number>): (pid: number) => boolean {
	const parent = new Map<number, number>();
	const group = new Map<number, number | undefined>();
	for (const p of procs) { parent.set(p.pid, p.ppid); group.set(p.pid, p.pgid); }
	return (pid) => {
		const pgid = group.get(pid);
		if (pgid !== undefined && groups.has(pgid)) return true;
		const seen = new Set<number>();
		for (let cur: number | undefined = pid; cur !== undefined && cur > 0 && !seen.has(cur); cur = parent.get(cur)) {
			if (owned.has(cur)) return true;
			seen.add(cur);
		}
		return false;
	};
}

/** The listening ports whose owning process is one of `owned` or descends
 *  from one, or sits in one of `groups`. */
export function portsOwnedBy(listeners: readonly Listener[], procs: readonly Proc[], owned: ReadonlySet<number>, groups: ReadonlySet<number> = new Set()): Set<string> {
	const isOwned = ownedBy(procs, owned, groups);
	const ports = new Set<string>();
	for (const l of listeners) {
		if (Number.isInteger(l.port) && l.port > 0 && l.port <= 65535 && isOwned(l.pid)) ports.add(String(l.port));
	}
	return ports;
}

// One PowerShell call prints listeners as `L <port> <pid>` and the process
// table as `P <pid> <ppid>`.
const WIN_SCRIPT =
	"Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { \"L $($_.LocalPort) $($_.OwningProcess)\" }; " +
	"Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object { \"P $($_.ProcessId) $($_.ParentProcessId)\" }";

export function parseWinTable(out: string): { listeners: Listener[]; procs: Proc[] } {
	const listeners: Listener[] = [];
	const procs: Proc[] = [];
	for (const line of out.split(/\r?\n/)) {
		const m = /^([LP]) (\d+) (\d+)$/.exec(line.trim());
		if (!m) continue;
		if (m[1] === "L") listeners.push({ port: Number(m[2]), pid: Number(m[3]) });
		else procs.push({ pid: Number(m[2]), ppid: Number(m[3]) });
	}
	return { listeners, procs };
}

// `lsof -F pn` prints `p<pid>` once per process, then `n<addr>:<port>` per socket.
export function parseLsof(out: string): Listener[] {
	const listeners: Listener[] = [];
	let pid = 0;
	for (const line of out.split("\n")) {
		if (line.startsWith("p")) pid = Number(line.slice(1));
		else if (line.startsWith("n")) {
			const port = Number(line.slice(line.lastIndexOf(":") + 1));
			if (pid > 0 && Number.isInteger(port)) listeners.push({ port, pid });
		}
	}
	return listeners;
}

// `ps -eo pid=,ppid=,pgid=` (BSD and procps spell all three).
export function parsePs(out: string): Proc[] {
	const procs: Proc[] = [];
	for (const line of out.split("\n")) {
		const m = /^\s*(\d+)\s+(\d+)(?:\s+(\d+))?\s*$/.exec(line);
		if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), ...(m[3] === undefined ? {} : { pgid: Number(m[3]) }) });
	}
	return procs;
}

function query(): { listeners: Listener[]; procs: Proc[] } {
	const opts = { encoding: "utf-8" as const, timeout: 5000, windowsHide: true };
	if (process.platform === "win32") {
		return parseWinTable(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN_SCRIPT], opts));
	}
	// Linux from /proc alone: a minimal container has neither lsof nor ps
	// (TB2 install-windows-3.11, 2026-10-29: "listener lookup failed: spawnSync
	// lsof ENOENT", so the agent's own QEMU port was nobody's).
	if (process.platform === "linux") return queryLinux();
	return {
		listeners: parseLsof(execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pn"], opts)),
		procs: parsePs(execFileSync("ps", ["-eo", "pid=,ppid=,pgid="], opts)),
	};
}

/** The pids listening on a TCP `port`, read from /proc (Linux only; null
 *  elsewhere, and when /proc could not be read: no answer is not "nothing"). */
export function linuxListeningPids(port: number): number[] | null {
	if (process.platform !== "linux") return null;
	try {
		return [...new Set(queryLinux().listeners.filter((l) => l.port === port).map((l) => l.pid))];
	} catch {
		return null;
	}
}

/** The live pid → ppid table, for a caller that must tell this process's own
 *  descendants from orphans (dev-server-readiness reclaimPort). Throws when
 *  the OS query fails; the caller decides what a missing table means. */
export function processTable(): Proc[] {
	return query().procs;
}

/**
 * Loopback ports currently held by a process_start session or its descendants.
 * Empty (and free) when no session is live; otherwise read from the OS at most
 * once per CACHE_MS. A query failure yields the empty set: no evidence, no port.
 */
export function ownedLoopbackPorts(): Set<string> {
	if (ownedPids.size === 0 && ownedGroups.size === 0) return new Set();
	if (cache && Date.now() - cache.at < CACHE_MS) return cache.ports;
	let ports: Set<string>;
	try {
		const { listeners, procs } = query();
		ports = portsOwnedBy(listeners, procs, ownedPids, pruneGroups(procs));
	} catch {
		ports = new Set();
	}
	cache = { at: Date.now(), ports };
	return ports;
}

/** Drop the groups no live process holds, and return the rest. */
function pruneGroups(procs: readonly Proc[]): ReadonlySet<number> {
	const live = liveGroups(ownedGroups, procs);
	for (const g of ownedGroups) if (!live.has(g)) ownedGroups.delete(g);
	return live;
}

/** The socket paths whose listening process is one of `owned` or descends
 *  from one, or sits in one of `groups`. */
export function socketsOwnedBy(listeners: readonly SocketListener[], procs: readonly Proc[], owned: ReadonlySet<number>, groups: ReadonlySet<number> = new Set()): Set<string> {
	const isOwned = ownedBy(procs, owned, groups);
	return new Set(listeners.filter((l) => l.path.startsWith("/") && isOwned(l.pid)).map((l) => l.path));
}

// /proc/net/unix: `Num RefCount Protocol Flags Type St Inode Path`. Flags
// 0x10000 (__SO_ACCEPTCON) marks a listening socket; a path starting with `@`
// is abstract (no file), and an unbound socket has none.
export function parseProcNetUnix(text: string): Map<string, string> {
	const byInode = new Map<string, string>();
	for (const line of text.split("\n").slice(1)) {
		const f = line.trim().split(/\s+/);
		if (f.length < 8 || (parseInt(f[3], 16) & 0x10000) === 0 || !f[7].startsWith("/")) continue;
		byInode.set(f[6], f.slice(7).join(" "));
	}
	return byInode;
}

// /proc/net/tcp and tcp6: `sl local_address rem_address st … inode`, the
// address as hex `ADDR:PORT`, st 0A a listening socket. Inode → port.
export function parseProcNetTcp(text: string): Map<string, number> {
	const byInode = new Map<string, number>();
	for (const line of text.split("\n").slice(1)) {
		const f = line.trim().split(/\s+/);
		if (f.length < 10 || f[3] !== "0A") continue;
		const port = parseInt(f[1].slice(f[1].lastIndexOf(":") + 1), 16);
		if (Number.isInteger(port)) byInode.set(f[9], port);
	}
	return byInode;
}

// `/proc/<pid>/stat` is `pid (comm) state ppid pgrp session …`; comm may hold
// spaces and parens, so the fields are read after its LAST `)`.
export function parseProcStat(stat: string): { ppid: number; pgid: number } | null {
	const [, ppid, pgid] = stat.slice(stat.lastIndexOf(")") + 2).split(" ").map(Number);
	return Number.isInteger(ppid) && Number.isInteger(pgid) ? { ppid, pgid } : null;
}

function readProcNet(name: string): string {
	try { return readFileSync(`/proc/net/${name}`, "utf-8"); } catch { return ""; /* a kernel without that family lists nothing */ }
}

/** Linux, from /proc alone: a minimal container has neither lsof nor ps. One
 *  walk of /proc/<pid>/fd maps each process's socket inodes to the TCP ports
 *  and Unix socket paths /proc/net says are listening. */
function queryLinux(): { listeners: Listener[]; sockets: SocketListener[]; procs: Proc[] } {
	const portByInode = new Map([...parseProcNetTcp(readProcNet("tcp")), ...parseProcNetTcp(readProcNet("tcp6"))]);
	const pathByInode = parseProcNetUnix(readProcNet("unix"));
	const listeners: Listener[] = [];
	const sockets: SocketListener[] = [];
	const procs: Proc[] = [];
	for (const d of readdirSync("/proc")) {
		if (!/^\d+$/.test(d)) continue;
		const pid = Number(d);
		try {
			const stat = parseProcStat(readFileSync(`/proc/${d}/stat`, "utf-8"));
			if (stat !== null) procs.push({ pid, ...stat });
			for (const fd of readdirSync(`/proc/${d}/fd`)) {
				const inode = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${d}/fd/${fd}`))?.[1];
				if (inode === undefined) continue;
				const port = portByInode.get(inode);
				if (port !== undefined) listeners.push({ port, pid });
				const path = pathByInode.get(inode);
				if (path) sockets.push({ path, pid });
			}
		} catch { /* the process exited or its fds are another user's: no evidence from it */ }
	}
	return { listeners, sockets, procs };
}

/**
 * Unix socket files a process_start session or its descendants listen on,
 * symlinks resolved. Linux only: /proc marks a LISTENING socket exactly, while
 * macOS's lsof can show the path a client end connected to (an agent process
 * talking to docker.sock would read as holding it), so elsewhere there is no
 * evidence and the set is empty. Read at most once per CACHE_MS; a query
 * failure yields the empty set: no evidence, no socket.
 */
export function ownedUnixSockets(): Set<string> {
	if ((ownedPids.size === 0 && ownedGroups.size === 0) || process.platform !== "linux") return new Set();
	if (socketCache && Date.now() - socketCache.at < CACHE_MS) return socketCache.paths;
	let paths = new Set<string>();
	try {
		const { sockets, procs } = queryLinux();
		for (const p of socketsOwnedBy(sockets, procs, ownedPids, pruneGroups(procs))) {
			try { paths.add(realpathSync(p)); } catch { /* bound, then unlinked: no file to reach */ }
		}
	} catch {
		paths = new Set();
	}
	socketCache = { at: Date.now(), paths };
	return paths;
}
