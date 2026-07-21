import { existsSync } from "node:fs";
import { acquireMutationLock, releaseMutationLock } from "../../scripts/installer/transaction-lock.mjs";

const [dataDirectory, barrier] = process.argv.slice(2);
while (!existsSync(barrier)) await new Promise((resolve) => setTimeout(resolve, 5));
const lock = await acquireMutationLock(dataDirectory, { task: "test mutation" });
process.stdout.write(`${JSON.stringify({ acquired: lock.acquired, pid: process.pid })}\n`);
if (!lock.acquired) process.exit(0);
const release = async () => { await releaseMutationLock(lock); process.exit(0); };
process.once("SIGTERM", release);
process.once("SIGINT", release);
setInterval(() => {}, 1_000);
