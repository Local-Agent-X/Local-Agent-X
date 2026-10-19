import { createServer } from "node:net";

/** Whether this process may bind the loopback port right now. */
function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/**
 * `width` consecutive loopback ports this process bound a moment ago. Picked at
 * random below every OS's ephemeral range (Windows and macOS 49152+, Linux
 * 32768+), so they cannot collide with ports another test file is handed by
 * listen(0) at the same moment, nor sit in a block Windows reserved for
 * Hyper-V, WSL2 or Docker.
 */
export async function bindablePortRange(width: number): Promise<{ from: number; to: number }> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const from = 20_000 + Math.floor(Math.random() * 10_000);
    let all = true;
    for (let port = from; port < from + width && all; port++) all = await canBind(port);
    if (all) return { from, to: from + width - 1 };
  }
  throw new Error(`no ${width} consecutive loopback ports could be bound`);
}
