// The in-cage half of the Linux egress bridge, as a JavaScript source string.
//
// A guarded shell on Linux runs in an empty network namespace: no route off
// the machine and no route to the host's loopback either. The host proxy is
// reached over a unix socket bind-mounted into the cage. This program is the
// first process inside the cage: it listens on the proxy's own loopback port
// (so the proxy URL in the shell's env is the same on both sides of the wall),
// forwards each connection to that socket, and only then starts the shell,
// with the shell's stdio and signals passed straight through. When the shell
// exits, so does this.
//
// It is a string, run with `node -e`, rather than a file: the cage binds the
// host root, so the node binary that runs LAX is there, but a file would have
// to be resolved to a dist path in production and a source path under tsx —
// the string is the same in both. It uses nothing outside node's builtins.
export const NS_FORWARDER_SOURCE = `
const net = require("node:net");
const { spawn } = require("node:child_process");
const argv = process.argv.slice(1);
if (argv[0] === "--") argv.shift();
const socketPath = argv[0];
const port = Number(argv[1]);
const target = argv.slice(argv.indexOf("--", 2) + 1);
let launched = false;
function launch() {
  if (launched) return;
  launched = true;
  const child = spawn(target[0], target.slice(1), { stdio: "inherit" });
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => { try { child.kill(sig); } catch {} });
  }
  child.on("error", (e) => { process.stderr.write("lax-ns-forwarder: cannot start the shell: " + e.message + "\\n"); process.exit(127); });
  child.on("exit", (code, signal) => process.exit(code === null ? (signal === "SIGKILL" ? 137 : 143) : code));
}
const server = net.createServer((client) => {
  const upstream = net.connect(socketPath);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.pipe(upstream).pipe(client);
});
server.on("error", (e) => {
  process.stderr.write("lax-ns-forwarder: no egress bridge on 127.0.0.1:" + port + " (" + e.code + "); this shell has no route off the machine\\n");
  launch();
});
server.listen(port, "127.0.0.1", launch);
`;
