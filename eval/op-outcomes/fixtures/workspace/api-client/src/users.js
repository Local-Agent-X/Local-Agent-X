import { getJson } from "./http.js";

export function getUser(fetchImpl, id) {
  return getJson(fetchImpl, `/users/${id}`);
}
