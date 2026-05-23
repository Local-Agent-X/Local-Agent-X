import { randomBytes } from "node:crypto";

let agentCounter = 0;

export function nextAgentId(): string {
  return `agent-${++agentCounter}-${Date.now().toString(36)}`;
}

export function planId(): string {
  return `plan-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Task timed out")), ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
