import {
  closeSync, constants, existsSync, fstatSync, lstatSync, openSync,
  readFileSync, readlinkSync, realpathSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { dirname, join, resolve } from "node:path";

const FILE = "self-edit-sandbox.lock";
let currentIncarnation;
const localClaims = new Map();

function samePath(left, right) {
  return process.platform === "win32"
    ? resolve(left).toLocaleLowerCase("en-US") === resolve(right).toLocaleLowerCase("en-US")
    : resolve(left) === resolve(right);
}

function trustedDirectory(path) {
  if (!existsSync(path)) return { path: resolve(path), real: null, missing: true };
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(realpathSync(path), path)) return null;
  return { path: resolve(path), real: resolve(realpathSync(path)), dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs };
}

function sameIdentity(left, right) {
  if (left?.missing || right?.missing) return left?.missing === true && right?.missing === true && samePath(left.path, right.path);
  return left && right && samePath(left.path, right.path) && samePath(left.real, right.real)
    && left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function resolveWindowsProcessIncarnation(pid, runner = spawnSync, systemRoot = process.env.SystemRoot || "C:\\Windows") {
  const executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const commands = [
    `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" -ErrorAction Stop).CreationDate.ToUniversalTime().Ticks`,
    `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
  ];
  for (const command of commands) {
    const result = runner(executable, ["-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf-8", windowsHide: true, timeout: 5_000,
    });
    const value = result.status === 0 ? result.stdout.trim() : "";
    if (/^\d+$/.test(value)) return `win:${value}`;
  }
  return null;
}

function processIncarnation(pid) {
  if (pid === process.pid && currentIncarnation !== undefined) return currentIncarnation;
  let identity = null;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
      identity = `linux:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`;
    } else if (process.platform === "win32") {
      identity = resolveWindowsProcessIncarnation(pid);
    } else {
      const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8", timeout: 5_000 });
      identity = result.status === 0 && result.stdout.trim() ? `posix:${result.stdout.trim()}` : null;
    }
  } catch { identity = null; }
  if (pid === process.pid) currentIncarnation = identity;
  return identity;
}

function processMetadata(pid) {
  try {
    if (process.platform === "win32") {
      const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const command = `$p=Get-Process -Id ${pid} -ErrorAction Stop; [pscustomobject]@{startedAtMs=([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds(); executable=$p.Path}|ConvertTo-Json -Compress`;
      const result = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", command], {
        encoding: "utf-8", windowsHide: true, timeout: 5_000,
      });
      if (result.status !== 0) return null;
      const value = JSON.parse(result.stdout.trim());
      return Number.isFinite(value.startedAtMs) && typeof value.executable === "string" ? value : null;
    }
    const started = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8", timeout: 5_000 });
    if (started.status !== 0 || !started.stdout.trim()) return null;
    const executable = process.platform === "linux"
      ? readlinkSync(`/proc/${pid}/exe`)
      : spawnSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf-8", timeout: 5_000 }).stdout.trim();
    const startedAtMs = Date.parse(started.stdout.trim());
    return Number.isFinite(startedAtMs) && executable ? { startedAtMs, executable } : null;
  } catch { return null; }
}

function readEvidence(path) {
  let info;
  try { info = lstatSync(path); }
  catch (error) { return error?.code === "ENOENT" ? { kind: "empty", holder: null } : { kind: "unsafe", holder: null }; }
  if (!info.isFile() || info.isSymbolicLink()) return { kind: "unsafe", holder: null };
  try {
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let value;
    try {
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.birthtimeMs !== info.birthtimeMs) {
        return { kind: "unsafe", holder: null };
      }
      value = JSON.parse(readFileSync(descriptor, "utf-8"));
    } finally { closeSync(descriptor); }
    if (!Number.isInteger(value?.pid) || typeof value.startedAt !== "string") return { kind: "corrupt", holder: null };
    if (value.version === 2 && typeof value.ticket === "string" && typeof value.incarnation === "string") {
      return { kind: "valid", holder: value };
    }
    return { kind: "legacy", holder: { ...value, version: 1 } };
  } catch { return { kind: "corrupt", holder: null }; }
}

function evidenceIsLive(evidence, resolveIncarnation = processIncarnation, resolveLegacyIdentity = processMetadata) {
  const holder = evidence.holder;
  if (!holder || !pidAlive(holder.pid)) return false;
  if (evidence.kind === "legacy") {
    const observed = resolveLegacyIdentity(holder.pid);
    if (!observed) return true;
    if (holder.executable && !samePath(holder.executable, observed.executable)) return false;
    const recordedAt = Date.parse(holder.startedAt);
    return !Number.isFinite(recordedAt) || recordedAt + 1_000 >= observed.startedAtMs;
  }
  const observed = resolveIncarnation(holder.pid);
  return observed === null || observed === holder.incarnation;
}

function endpointFor(dataDirectory) {
  const canonical = process.platform === "win32"
    ? resolve(dataDirectory).toLocaleLowerCase("en-US") : resolve(dataDirectory);
  const digest = createHash("sha256").update(canonical).digest();
  const rootHash = digest.toString("hex");
  if (process.platform === "win32") return { listen: { path: `\\\\.\\pipe\\lax-mutation-${rootHash}` }, rootHash };
  if (process.platform === "linux") return { listen: { path: `\0lax-mutation-${rootHash}` }, rootHash };
  const listens = Array.from({ length: 16 }, (_, index) => ({
    host: "127.0.0.1",
    port: 32_768 + createHash("sha256").update(`${rootHash}:${index}`).digest().readUInt16BE(0) % 28_000,
  }));
  return { listen: listens[0], listens, rootHash };
}

function endpointCandidates(endpoint) {
  return (endpoint.listens || [endpoint.listen]).map((listen) => ({ ...endpoint, listen, listens: undefined }));
}

function claimKernel(endpoint, state = {}) {
  return new Promise((resolveClaim) => {
    const server = createServer((socket) => {
      let request = "";
      let handled = false;
      socket.setEncoding("utf-8");
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        request += chunk;
        if (handled || !request.includes("\n")) return;
        handled = true;
        let message;
        try { message = JSON.parse(request.split(/\r?\n/, 1)[0]); } catch { message = {}; }
        socket.end(`${JSON.stringify({ rootHash: endpoint.rootHash, claimTicket: state.claimTicket, holder: state.holder, revokeAccepted: false })}\n`);
      });
      socket.on("end", () => {
        if (!request) socket.end(`${JSON.stringify({ rootHash: endpoint.rootHash, claimTicket: state.claimTicket, holder: state.holder, revokeAccepted: false })}\n`);
      });
    });
    const finish = (value) => {
      server.removeAllListeners("error");
      server.removeAllListeners("listening");
      resolveClaim(value);
    };
    server.once("error", () => finish(null));
    server.once("listening", () => { server.unref(); finish(server); });
    server.listen(endpoint.listen);
  });
}

function closeKernel(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

async function closeKernelSet(servers = []) {
  await Promise.all(servers.map(({ server }) => closeKernel(server)));
}

function queryKernel(endpoint, action = "observe") {
  return new Promise((resolveQuery) => {
    const socket = createConnection(endpoint.listen);
    let response = "";
    let connected = false;
    const timer = setTimeout(() => finish({ kind: connected ? "unresponsive" : "absent", reply: null }), 500);
    const finish = (value) => { clearTimeout(timer); socket.destroy(); resolveQuery(value); };
    socket.setEncoding("utf-8");
    socket.once("error", (error) => finish({ kind: ["ENOENT", "ECONNREFUSED"].includes(error?.code) ? "absent" : "unsafe", reply: null }));
    socket.on("data", (chunk) => {
      response += chunk;
      if (!response.includes("\n")) return;
      try { finish({ kind: "reply", reply: JSON.parse(response.split(/\r?\n/, 1)[0]) }); }
      catch { finish({ kind: "unsafe", reply: null }); }
    });
    socket.once("connect", () => {
      connected = true;
      socket.write(`${JSON.stringify({ action, rootHash: endpoint.rootHash })}\n`);
    });
  });
}

async function observeKernelSet(endpoint) {
  let unusable = 0;
  const free = [];
  const owners = [];
  for (const candidate of endpointCandidates(endpoint)) {
    const observed = await queryKernel(candidate);
    if (observed.kind === "reply" && observed.reply?.rootHash === endpoint.rootHash) {
      owners.push({ candidate, reply: observed.reply });
      continue;
    }
    if (observed.kind === "absent") free.push(candidate);
    else unusable += 1;
  }
  if (owners.length > 0) return { kind: "held", owners, candidate: owners[0].candidate, reply: owners[0].reply, free };
  return { kind: free.length > 0 ? "available" : "unsafe", owners, free, unusable, reply: null };
}

async function claimKernelSet(endpoint, state = {}) {
  state.claimTicket ||= randomUUID();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observed = await observeKernelSet(endpoint);
    if (observed.kind !== "available") return { server: null, observed };
    const servers = [];
    for (const candidate of observed.free) {
      const server = await claimKernel(candidate, state);
      if (server) {
        servers.push({ server, endpoint: candidate });
        continue;
      }
      const raced = await queryKernel(candidate);
      if (raced.kind === "reply" && raced.reply?.rootHash === endpoint.rootHash) {
        const winner = [state.claimTicket, raced.reply.claimTicket].filter(Boolean).sort()[0];
        if (winner !== state.claimTicket) {
          await closeKernelSet(servers);
          return { server: null, observed: { kind: "held", candidate, reply: raced.reply } };
        }
      }
    }
    if (servers.length === 0) continue;
    const arbitration = await observeKernelSet(endpoint);
    const foreign = arbitration.owners?.filter((owner) => owner.reply?.claimTicket !== state.claimTicket) || [];
    if (foreign.length > 0) {
      const tickets = [state.claimTicket, ...foreign.map((owner) => owner.reply?.claimTicket)].filter(Boolean).sort();
      const winner = tickets[0];
      if (winner !== state.claimTicket) {
        await closeKernelSet(servers);
        return { server: null, observed: { kind: "held", ...foreign[0] } };
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      const settled = await observeKernelSet(endpoint);
      if (settled.owners?.some((owner) => owner.reply?.claimTicket !== state.claimTicket)) {
        await closeKernelSet(servers);
        continue;
      }
    }
    return { server: servers[0].server, servers, endpoint: servers[0].endpoint, observed: { kind: "acquired" } };
  }
  return { server: null, observed: { kind: "unsafe", reply: null } };
}

async function waitForRevokedClaim(endpoint, state, timeoutMs) {
  const held = await observeKernelSet(endpoint);
  if (held.kind !== "held") return null;
  const owner = localClaims.get(endpoint.rootHash);
  if (!owner?.onRevoke || !held.owners.some(({ reply }) => reply?.claimTicket === owner.claimTicket)) return null;
  if (owner.onRevoke() === false) return null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const claim = await claimKernelSet(endpoint, state);
    if (claim.server) return claim;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return null;
}

export async function acquireMutationLock(dataDirectory, options = {}) {
  const identity = trustedDirectory(dataDirectory);
  const path = join(dataDirectory, FILE);
  if (!identity) return { acquired: false, unsafeState: true, path };
  const initial = readEvidence(path);
  if (["unsafe", "corrupt"].includes(initial.kind)) return { acquired: false, unsafeState: true, path };
  if (initial.kind === "legacy" && evidenceIsLive(
    initial, options.resolveIncarnation || processIncarnation, options.resolveLegacyProcessIdentity || processMetadata,
  )) {
    return { acquired: false, holder: initial.holder, path };
  }
  const endpoint = endpointFor(dataDirectory);
  const state = { holder: null, onRevoke: options.onRevoke };
  let claim = await claimKernelSet(endpoint, state);
  if (!claim.server && options.force) claim = await waitForRevokedClaim(endpoint, state, options.revokeTimeoutMs ?? 5_000) || claim;
  if (!claim.server) {
    return {
      acquired: false, holder: claim.observed?.reply?.holder || readEvidence(path).holder || undefined,
      unsafeState: claim.observed?.kind === "unsafe", path,
    };
  }
  const server = claim.server;

  const afterClaim = readEvidence(path);
  if (["unsafe", "corrupt"].includes(afterClaim.kind)
    || (afterClaim.kind === "legacy" && evidenceIsLive(
      afterClaim, options.resolveIncarnation || processIncarnation, options.resolveLegacyProcessIdentity || processMetadata,
    ))
    || !sameIdentity(identity, trustedDirectory(dataDirectory))) {
    await closeKernelSet(claim.servers || [{ server }]);
    return { acquired: false, holder: afterClaim.holder || undefined, unsafeState: afterClaim.kind !== "valid", path };
  }
  const ticket = randomUUID();
  const incarnation = (options.resolveIncarnation || processIncarnation)(process.pid);
  if (!incarnation) {
      await closeKernelSet(claim.servers || [{ server }]);
    return { acquired: false, unsafeState: true, path };
  }
  const holder = { version: 2, pid: process.pid, ticket, incarnation, task: options.task, startedAt: new Date().toISOString() };
  state.holder = holder;
  localClaims.set(endpoint.rootHash, state);
  return { acquired: true, nonce: ticket, ticket, holder, path, identity, endpoint: claim.endpoint, rootHash: endpoint.rootHash, state, server, servers: claim.servers };
}

export async function releaseMutationLock(lock) {
  if (!lock?.acquired) return;
  if (localClaims.get(lock.rootHash) === lock.state) localClaims.delete(lock.rootHash);
  await closeKernelSet(lock.servers || [{ server: lock.server }]);
}

export async function mutationLockHeldByLiveProcess(dataDirectory) {
  const identity = trustedDirectory(dataDirectory);
  if (!identity) return true;
  const evidence = readEvidence(join(dataDirectory, FILE));
  if (["unsafe", "corrupt"].includes(evidence.kind)) return true;
  if (evidence.kind === "legacy" && evidenceIsLive(evidence)) return true;
  const endpoint = endpointFor(dataDirectory);
  const claim = await claimKernelSet(endpoint);
  if (!claim.server) return claim.observed?.kind !== "available";
  const server = claim.server;
  if (!sameIdentity(identity, trustedDirectory(dataDirectory))) {
    await closeKernelSet(claim.servers || [{ server }]);
    return true;
  }
  await closeKernelSet(claim.servers || [{ server }]);
  return false;
}

export function mutationLockPath(dataDirectory) { return join(dataDirectory, FILE); }
export function mutationLockEndpoint(dataDirectory) { return endpointFor(dataDirectory); }
