// BrokerPresence — keeps THIS desktop dialed into the broker so its paired phone can
// reach it. In the broker model the phone is the dialer and the desktop must be
// PRESENT in the rendezvous, waiting; this supervisor is that presence.
//
// A BrokerScreenDialer is single-use (one socket → one screen session → terminal). So
// the supervisor (re)builds a dialer: on start it dials, and whenever the current dialer
// closes (phone left, error, or a transport drop) it schedules a reconnect after a short
// backoff — giving "the phone can reconnect and get a fresh live session" without manual
// intervention. Stop tears everything down and cancels any pending reconnect.
//
// Pure over an injected dialer factory + timers, so the reconnect logic unit-tests
// offline (a fake dialer whose onClosed the test fires, a synchronous timer). The
// production factory wires the real ws socket + data-channel control (defaultDeps).

import { buildConnectUrl } from "./vendor/connect-url.js";
import { openBrokerSocket } from "./ws-socket-adapter.js";
import { DataChannelControl } from "./control-channel.js";
import { ChatBridge } from "./chat-bridge.js";
import { openBrokerChatLoopback } from "./chat-loopback.js";
import { HttpTunnelBridge } from "./http-tunnel-bridge.js";
import { BrokerScreenDialer } from "./broker-screen-dialer.js";
import { getRuntimeConfig } from "../config.js";
import { createLogger } from "../logger.js";

const logger = createLogger("broker-transport.presence");

/** Default delay before re-dialing after a dialer closes. */
const DEFAULT_RECONNECT_MS = 3000;

export interface BrokerPresenceConfig {
  /** Broker base URL (ws/wss), no /connect suffix. */
  brokerWsUrl: string;
  /** This desktop's own device id (the broker `device=`). */
  deviceId: string;
  /** The paired phone's device id (the broker `target=` we wait to meet). */
  pairedPhoneId: string;
  /** Read the current session bearer token fresh on each (re)dial, so a refreshed
   *  token is used after a re-login rather than a stale captured one. */
  getToken: () => string;
}

/** A live dialer the supervisor can stop. The real BrokerScreenDialer satisfies it. */
export interface DialerHandle {
  stop(): void;
}

export interface BrokerPresenceDeps {
  /** Build + start a dialer for one rendezvous session. `onClosed` MUST be invoked
   *  when the dialer goes terminal so the supervisor can reconnect. */
  createDialer: (connectUrl: string, token: string, onClosed: () => void) => DialerHandle;
  reconnectMs: number;
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
}

export class BrokerPresence {
  private readonly config: BrokerPresenceConfig;
  private readonly deps: BrokerPresenceDeps;
  private current: DialerHandle | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(config: BrokerPresenceConfig, deps: BrokerPresenceDeps) {
    this.config = config;
    this.deps = deps;
  }

  /** Begin maintaining presence: dial now, reconnect on every close until stopped. */
  start(): void {
    if (this.stopped) return;
    this.dial();
  }

  /** Stop maintaining presence: cancel any pending reconnect + stop the live dialer. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      this.deps.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.current?.stop();
    this.current = null;
  }

  private dial(): void {
    if (this.stopped) return;
    const token = this.config.getToken();
    if (!token) {
      // No token (signed out / expired) — don't dial; a re-login + restart re-arms us.
      logger.warn("[broker-transport] presence: no session token, not dialing");
      return;
    }
    const connectUrl = buildConnectUrl({
      brokerWsUrl: this.config.brokerWsUrl,
      role: "desktop",
      target: this.config.pairedPhoneId,
      device: this.config.deviceId,
      token,
    });
    logger.info(`[broker-transport] presence: dialing broker as desktop ${this.config.deviceId}`);
    this.current = this.deps.createDialer(connectUrl, token, () => this.onDialerClosed());
  }

  private onDialerClosed(): void {
    this.current = null;
    if (this.stopped) return;
    this.reconnectTimer = this.deps.setTimer(() => {
      this.reconnectTimer = null;
      this.dial();
    }, this.deps.reconnectMs);
  }
}

/** Production deps: build a real ws-backed dialer with a data-channel control path. */
export function defaultPresenceDeps(): BrokerPresenceDeps {
  return {
    createDialer: (connectUrl, token, onClosed) => {
      const socket = openBrokerSocket(connectUrl, token);
      const control = new DataChannelControl();
      // Chat rides the peer's `chat` data channel, bridged to the desktop's own /ws/chat
      // over loopback (operator-authed; read fresh so a re-login's token is current).
      const chat = new ChatBridge({
        openLoopback: () => {
          const cfg = getRuntimeConfig();
          return openBrokerChatLoopback(cfg.port, cfg.authToken);
        },
      });
      // Device REST (app list / sessions / settings) tunnels to the desktop's own loopback,
      // device-scoped (the HttpTunnelBridge enforces the same allowlist a tailnet device had).
      const http = new HttpTunnelBridge({
        loopback: () => {
          const cfg = getRuntimeConfig();
          return { origin: `http://127.0.0.1:${cfg.port}`, token: cfg.authToken };
        },
      });
      return new BrokerScreenDialer({ socket, control, chat, http, onClosed });
    },
    reconnectMs: DEFAULT_RECONNECT_MS,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (timer) => clearTimeout(timer),
  };
}

/** Construct + start a desktop broker presence from config. Returns it for shutdown. */
export function startBrokerPresence(config: BrokerPresenceConfig): BrokerPresence {
  const presence = new BrokerPresence(config, defaultPresenceDeps());
  presence.start();
  return presence;
}
