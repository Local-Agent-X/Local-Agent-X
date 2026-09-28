/**
 * The loopback ports held by processes THIS harness spawned through
 * process_start — a dependency-free leaf (node:child_process only) the security
 * layer folds into its local-service ports, the same way it folds in the
 * dev-server record store (dev-server-records.ts, and for the same reason: the
 * layer cannot import process-session.ts without a cycle).
 *
 * Evidence, not configuration: a port is reachable because a process the
 * agent started (or a descendant of it — `npm run dev` forks the server that
 * actually binds) is listening on it, for exactly as long as it runs. On
 * 2026-09-25 the agent started `langgraph dev` and was then refused
 * `http://127.0.0.1:2024/ok` seventeen times as a "private/reserved IPv4
 * address", with a recovery that told it to edit security.json — a file it
 * may not touch. Ports only, never a host: the loopback-host gate in
 * network-policy still decides WHERE a port may be dialed.
 */
import { execFileSync } from "node:child_process";

export interface Listener { port: number; pid: number }
export interface Proc { pid: number; ppid: number }

const ownedPids = new Set<number>();
let cache: { at: number; ports: Set<string> } | null = null;
const CACHE_MS = 3000;

export function registerOwnedProcess(pid: number | null | undefined): void {
	if (typeof pid === "number" && pid > 0) {
		ownedPids.add(pid);
		cache = null;
	}
}

export function unregisterOwnedProcess(pid: number | null | undefined): void {
	if (typeof pid === "number") {
		ownedPids.delete(pid);
		cache = null;
	}
}

/** The listening ports whose owning process is one of `owned` or descends from one. */
export function portsOwnedBy(listeners: readonly Listener[], procs: readonly Proc[], owned: ReadonlySet<number>): Set<string> {
	const parent = new Map<number, number>();
	for (const p of procs) parent.set(p.pid, p.ppid);
	const isOwned = (pid: number): boolean => {
		const seen = new Set<number>();
		for (let cur: number | undefined = pid; cur !== undefined && cur > 0 && !seen.has(cur); cur = parent.get(cur)) {
			if (owned.has(cur)) return true;
			seen.add(cur);
		}
		return false;
	};
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

export function parsePs(out: string): Proc[] {
	const procs: Proc[] = [];
	for (const line of out.split("\n")) {
		const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
		if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]) });
	}
	return procs;
}

function query(): { listeners: Listener[]; procs: Proc[] } {
	const opts = { encoding: "utf-8" as const, timeout: 5000, windowsHide: true };
	if (process.platform === "win32") {
		return parseWinTable(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN_SCRIPT], opts));
	}
	return {
		listeners: parseLsof(execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pn"], opts)),
		procs: parsePs(execFileSync("ps", ["-eo", "pid=,ppid="], opts)),
	};
}

/**
 * Loopback ports currently held by a process_start session or its descendants.
 * Empty (and free) when no session is live; otherwise read from the OS at most
 * once per CACHE_MS. A query failure yields the empty set: no evidence, no port.
 */
export function ownedLoopbackPorts(): Set<string> {
	if (ownedPids.size === 0) return new Set();
	if (cache && Date.now() - cache.at < CACHE_MS) return cache.ports;
	let ports: Set<string>;
	try {
		const { listeners, procs } = query();
		ports = portsOwnedBy(listeners, procs, ownedPids);
	} catch {
		ports = new Set();
	}
	cache = { at: Date.now(), ports };
	return ports;
}
