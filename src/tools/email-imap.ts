import { ImapFlow } from "imapflow";

interface ImapMessage {
  uid: number;
  envelope: {
    from?: { name?: string; address?: string }[];
    subject?: string;
    date?: Date;
  };
  source?: Buffer;
  bodyStructure?: unknown;
}

export async function fetchMessages(
  cfg: { host: string; port: number; user: string; pass: string },
  folder: string,
  uids: number[] | string,
  limit: number,
): Promise<{ from: string; subject: string; date: string; snippet: string }[]> {
  const client = new ImapFlow({ host: cfg.host, port: cfg.port, secure: true, auth: { user: cfg.user, pass: cfg.pass }, logger: false });
  try {
    await client.connect();
    const lock = await client.getMailboxLock(folder);
    try {
      const range = Array.isArray(uids) ? uids.slice(0, limit).join(",") : uids;
      const messages: { from: string; subject: string; date: string; snippet: string }[] = [];
      let count = 0;
      for await (const msg of client.fetch(range || "1:*", { envelope: true, source: true }, { uid: true })) {
        if (count >= limit) break;
        const env = (msg as unknown as ImapMessage).envelope;
        const from = env?.from?.[0] ? `${env.from[0].name || ""} <${env.from[0].address || ""}>`.trim() : "unknown";
        const subject = env?.subject || "(no subject)";
        const date = env?.date ? new Date(env.date).toISOString() : "unknown";
        const raw = (msg as unknown as ImapMessage).source?.toString("utf-8") || "";
        const bodyStart = raw.indexOf("\r\n\r\n");
        const snippet = bodyStart > -1 ? raw.slice(bodyStart + 4, bodyStart + 304).replace(/\r?\n/g, " ").trim() : "";
        messages.push({ from, subject, date, snippet: snippet.slice(0, 200) });
        count++;
      }
      return messages;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}
