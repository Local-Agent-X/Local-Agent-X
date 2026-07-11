import {
  AssociativeStore,
  MAX_ASSOCIATIONS,
  MAX_NODES,
  STORE_FILE,
} from "./types.js";
import { createJsonStore } from "../../util/json-store.js";

const store = createJsonStore<AssociativeStore>(STORE_FILE, {
  defaults: () => ({ nodes: [], associations: [] }),
  caps: { nodes: MAX_NODES, associations: MAX_ASSOCIATIONS },
});

export function loadStore(): AssociativeStore {
  return store.load();
}

export function saveStore(value: AssociativeStore): void {
  store.save(value);
}
