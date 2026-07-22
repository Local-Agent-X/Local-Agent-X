/**
 * container-taint-forward — the CONTAINER-side driver that pushes this process's
 * data-lineage state (sensitive-read taint + session canaries) to the host over
 * the browser relay as it accrues.
 *
 * Runs only inside a container that has the browser relay activated (an agent
 * loop whose views are relayed to the host). It subscribes to the container's
 * OWN taint/canary registries and forwards every post-mutation delta to the host
 * (relayForwardTaint / relayForwardCanaries), so the host's page-egress exfil
 * scan evaluates a container-relayed request against the taint the container
 * actually accrued — closing the container blind spot (audit finding 5).
 *
 * Delivery is eventually-consistent and fire-and-forget with ordering preserved
 * by a single send chain: taint accrues turns before the agent decides to
 * browse, and the taint layer is the documented fail-open defense-in-depth (the
 * host URL/SSRF policy stays fail-closed independently). A relay hiccup logs and
 * is dropped rather than stalling the agent loop.
 */

import { createLogger } from "../logger.js";
import { subscribeTaintChanges } from "../data-lineage/index.js";
import { subscribeCanaryChanges } from "../threat/canaries.js";
import { browserContainerRelayActivated } from "./container-bridge-transport.js";
import { relayForwardCanaries, relayForwardTaint } from "./container-bridge-lineage.js";

const logger = createLogger("container-lineage");

/**
 * Start forwarding this container's taint/canary deltas to the host. No-op (and
 * a no-op stopper) when the browser relay is not activated — i.e. host-side or
 * non-browsing execution, where the host already owns the registries. Returns a
 * stop function that detaches both subscriptions.
 */
export function startContainerLineageForwarding(): () => void {
  if (!browserContainerRelayActivated()) return () => {};

  // One serialized send chain so full-state deltas can't interleave/reorder on
  // the wire; each send is fire-and-forget with the error logged, never thrown
  // into the subscribe callback (which runs inside recordSensitiveRead).
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (send: () => Promise<void>): void => {
    chain = chain.then(send).catch(e => logger.warn(`lineage forward failed: ${(e as Error).message}`));
  };

  const unsubTaint = subscribeTaintChanges((sessionId, entries) =>
    enqueue(() => relayForwardTaint(sessionId, [...entries])));
  const unsubCanaries = subscribeCanaryChanges((sessionId, canaries) =>
    enqueue(() => relayForwardCanaries(sessionId, [...canaries])));

  return () => {
    unsubTaint();
    unsubCanaries();
  };
}
