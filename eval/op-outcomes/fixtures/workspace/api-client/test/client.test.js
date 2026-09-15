import { test } from "node:test";
import assert from "node:assert/strict";
import * as client from "../src/index.js";

const fakeFetch = async (url) => ({ ok: true, json: async () => ({ url }) });

test("getUser requests the user path", async () => {
  assert.deepEqual(await client.getUser(fakeFetch, 7), { url: "/users/7" });
});

test("listOrders requests the orders path", async () => {
  assert.deepEqual(await client.listOrders(fakeFetch, 7), { url: "/users/7/orders" });
});

test("the JSON helper is exported", () => {
  assert.equal(typeof client.getJson, "function");
});
