// The smoke's click phase presses the page's main action the way a person
// would: after typing something. An "Add" that is disabled until its field has
// text used to leave the phase with nothing to press, so the app's save path
// (and the backend behind it) was never run by the check.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { smokeUrl } from "./smoke.js";

const chromiumAvailable = await (async () => {
  try {
    const { chromium } = await import("playwright");
    await (await chromium.launch({ headless: true })).close();
    return true;
  } catch {
    return false;
  }
})();

/** A list app: Add is disabled until the field has text, and saving posts it. */
const page = (onAdd: string): string => `<!doctype html><html><body><div id="root">
  <input id="name" placeholder="Add a habit"><input id="count" type="number">
  <button id="add" disabled>Add</button><button id="other">Other</button></div><script>
  const name = document.getElementById("name"), add = document.getElementById("add");
  name.addEventListener("input", () => { add.disabled = name.value.trim() === ""; });
  add.addEventListener("click", () => { ${onAdd} });
  document.getElementById("other").addEventListener("click", () => fetch("/other", { method: "POST" }));
</script></body></html>`;

const SAVE = 'fetch("/add", { method: "POST", body: name.value + ":" + document.getElementById("count").value });';

let server: Server;
let base = "";
const posted: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => { posted.push(`${req.url} ${Buffer.concat(chunks).toString("utf8")}`); res.end("ok"); });
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(page(req.url === "/broken" ? "undefinedSave(name.value);" : SAVE));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
beforeEach(() => { posted.length = 0; });

describe.skipIf(!chromiumAvailable)("smoke click phase", () => {
  it("types into the empty fields, then presses the button that typing enabled", async () => {
    const r = await smokeUrl(`${base}/app`, 15_000, undefined, { interact: {} });
    expect(r.interaction?.clicked).toBe(true);
    expect(r.interaction?.pageErrors).toEqual([]);
    expect(posted).toEqual(["/add Test:12"]);
  });

  it("reports a save path that throws once it can be reached", async () => {
    const r = await smokeUrl(`${base}/broken`, 15_000, undefined, { interact: {} });
    expect(r.pageErrors).toEqual([]);
    expect(r.interaction?.pageErrors.join("\n")).toContain("undefinedSave is not defined");
  });
});
