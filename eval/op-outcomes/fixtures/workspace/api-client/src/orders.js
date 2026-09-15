import { getJson } from "./http.js";

export function listOrders(fetchImpl, userId) {
  return getJson(fetchImpl, `/users/${userId}/orders`);
}
