import { EventEmitter } from "node:events";
import * as net from "node:net";
import { randomUUID } from "node:crypto";

export interface IPCMessage {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  correlationId?: string;
}

interface PendingRequest {
  resolve: (msg: IPCMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class IPCChannel extends EventEmitter {
  private socket: net.Socket | null = null;
  private server: net.Server | null = null;
  private connected = false;
  private reconnecting = false;
  private socketPath = "";
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private currentReconnectDelay = 1000;
  private requestTimeout = 10000;
  private pending = new Map<string, PendingRequest>();
  private recvBuffer = Buffer.alloc(0);
  private autoReconnect = true;

  async connect(path: string): Promise<void> {
    this.socketPath = path;
    this.currentReconnectDelay = this.reconnectDelay;
    return this.doConnect();
  }

  async listen(path: string): Promise<void> {
    this.socketPath = path;
    return new Promise((resolve, reject) => {
      this.server = net.createServer((client) => {
        this.attachSocket(client);
      });
      this.server.on("error", reject);
      this.server.listen(path, () => resolve());
    });
  }

  send(msg: IPCMessage): void {
    if (!this.socket || !this.connected) {
      throw new Error("Not connected");
    }
    this.writeFrame(msg);
  }

  request(
    type: string,
    payload: Record<string, unknown>,
    timeout?: number
  ): Promise<IPCMessage> {
    const id = randomUUID();
    const msg: IPCMessage = { id, type, payload };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${id} timed out`));
      }, timeout ?? this.requestTimeout);

      this.pending.set(id, { resolve, reject, timer });
      this.send(msg);
    });
  }

  onMessage(handler: (msg: IPCMessage) => void): void {
    this.on("message", handler);
  }

  disconnect(): void {
    this.autoReconnect = false;
    this.cleanup();
  }

  isConnected(): boolean {
    return this.connected;
  }

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath, () => {
        this.attachSocket(socket);
        resolve();
      });
      socket.once("error", (err) => {
        if (!this.connected) reject(err);
      });
    });
  }

  private attachSocket(socket: net.Socket): void {
    this.cleanup();
    this.socket = socket;
    this.connected = true;
    this.reconnecting = false;
    this.currentReconnectDelay = this.reconnectDelay;
    this.recvBuffer = Buffer.alloc(0);
    this.emit("connected");

    socket.on("data", (data: Buffer) => this.onData(data));
    socket.on("close", () => this.onClose());
    socket.on("error", (err) => this.emit("error", err));
  }

  private onData(data: Buffer): void {
    this.recvBuffer = Buffer.concat([this.recvBuffer, data]);
    this.processBuffer();
  }

  private processBuffer(): void {
    while (this.recvBuffer.length >= 4) {
      const frameLen = this.recvBuffer.readUInt32BE(0);
      if (this.recvBuffer.length < 4 + frameLen) break;

      const json = this.recvBuffer.subarray(4, 4 + frameLen).toString("utf-8");
      this.recvBuffer = this.recvBuffer.subarray(4 + frameLen);

      let msg: IPCMessage;
      try {
        msg = JSON.parse(json) as IPCMessage;
      } catch {
        this.emit("error", new Error("Invalid IPC frame"));
        continue;
      }

      if (msg.correlationId && this.pending.has(msg.correlationId)) {
        const req = this.pending.get(msg.correlationId)!;
        this.pending.delete(msg.correlationId);
        clearTimeout(req.timer);
        req.resolve(msg);
      } else {
        this.emit("message", msg);
      }
    }
  }

  private writeFrame(msg: IPCMessage): void {
    const json = JSON.stringify(msg);
    const payload = Buffer.from(json, "utf-8");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    this.socket!.write(Buffer.concat([header, payload]));
  }

  private onClose(): void {
    this.connected = false;
    this.emit("disconnected");

    const entries = Array.from(this.pending.entries());
    for (const [id, req] of entries) {
      clearTimeout(req.timer);
      req.reject(new Error("Connection closed"));
      this.pending.delete(id);
    }

    if (this.autoReconnect && !this.reconnecting) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    this.reconnecting = true;
    const delay = this.currentReconnectDelay;
    this.currentReconnectDelay = Math.min(
      this.currentReconnectDelay * 2,
      this.maxReconnectDelay
    );

    setTimeout(async () => {
      if (!this.autoReconnect) return;
      try {
        await this.doConnect();
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  private cleanup(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.connected = false;
  }
}
