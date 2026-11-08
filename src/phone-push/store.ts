// The phones LAX alerts, one registration per Expo push token, in
// <lax data dir>/phone-push.json. A phone's sealing key opens every alert sent
// to it, so it is stored encrypted under the app's master key (the one that
// guards the secrets vault), never in the clear; the token and the kinds are
// not secret.

import { createJsonStore } from "../util/json-store.js";
import { decrypt, encrypt } from "../secrets-crypto.js";
import type { InboxItemKind } from "../broker-transport/vendor/protocol.js";

/** A phone as the sender uses it: its key in the clear, in memory only. */
export interface PhoneRegistration {
  token: string;
  /** Base64 AES-256 key the phone generated; alerts are sealed with it. */
  key: string;
  kinds: InboxItemKind[];
  device?: string;
  registeredAt: number;
}

interface StoredPhone {
  token: string;
  sealedKey: string;
  kinds: InboxItemKind[];
  device?: string;
  registeredAt: number;
}

interface PushFile extends Record<string, unknown> {
  version: 1;
  phones: StoredPhone[];
}

/** More than this many phones and the oldest registration goes. */
export const MAX_PHONES = 10;

export interface PhonePushStore {
  /** Add the phone, or replace its key, kinds and label. */
  register(phone: Omit<PhoneRegistration, "registeredAt">): void;
  /** False when no phone has that token. */
  unregister(token: string): boolean;
  /** Every phone whose key opens under the current master key. */
  list(): PhoneRegistration[];
}

export function createPhonePushStore(
  filePath: string,
  masterKey: () => Buffer,
  onUnreadable: (token: string) => void = () => {},
  clock: () => number = Date.now,
): PhonePushStore {
  const file = createJsonStore<PushFile>(filePath, { defaults: () => ({ version: 1, phones: [] }) });
  return {
    register({ token, key, kinds, device }) {
      file.mutate((draft) => {
        const phones = draft.phones.filter((p) => p.token !== token);
        phones.push({ token, sealedKey: encrypt(key, masterKey()), kinds, ...(device ? { device } : {}), registeredAt: clock() });
        draft.phones = phones.slice(-MAX_PHONES);
      });
    },
    unregister(token) {
      return file.mutate((draft) => {
        const before = draft.phones.length;
        draft.phones = draft.phones.filter((p) => p.token !== token);
        return draft.phones.length < before;
      });
    },
    list() {
      const out: PhoneRegistration[] = [];
      for (const phone of file.load().phones) {
        let key: string;
        try {
          key = decrypt(phone.sealedKey, masterKey());
        } catch {
          // The master key changed (a restored or rotated vault): this phone
          // must register again, which it does on its next link.
          onUnreadable(phone.token);
          continue;
        }
        out.push({ token: phone.token, key, kinds: phone.kinds, ...(phone.device ? { device: phone.device } : {}), registeredAt: phone.registeredAt });
      }
      return out;
    },
  };
}
