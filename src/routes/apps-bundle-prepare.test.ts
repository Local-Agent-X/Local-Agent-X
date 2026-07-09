/**
 * prepareOfflineBundle — the on-demand static build that makes a client-only SPA
 * downloadable/offline, blocks apps that genuinely need the desktop, and rebuilds
 * a stale dist so an UPDATED app downloads its new pages.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let dataDir: string;
let workspace: string;
type Mod = typeof import("./apps-bundle-prepare.js");
let prepareOfflineBundle: Mod["prepareOfflineBundle"];

const fakeReg = { getState: () => null, get: () => undefined } as never;

beforeAll(async () => {
	dataDir = mkdtempSync(join(tmpdir(), "prep-data-"));
	workspace = mkdtempSync(join(tmpdir(), "prep-ws-"));
	process.env.LAX_DATA_DIR = dataDir;
	({ prepareOfflineBundle } = await import("./apps-bundle-prepare.js"));
});
afterAll(() => {
	delete process.env.LAX_DATA_DIR;
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(workspace, { recursive: true, force: true });
});

function appDir(id: string): string {
	const d = join(workspace, "apps", id);
	mkdirSync(d, { recursive: true });
	return d;
}
/** Minimal Vite SPA source: package.json with the vite dep + a src entry, NO dist. */
function writeViteSource(id: string): string {
	const d = appDir(id);
	writeFileSync(join(d, "package.json"), JSON.stringify({ name: id, devDependencies: { vite: "^7.0.0" } }));
	mkdirSync(join(d, "src"), { recursive: true });
	writeFileSync(join(d, "src", "main.tsx"), "export {}\n");
	writeFileSync(join(d, "index.html"), "<html><body><script type=module src=/src/main.tsx></script></body></html>");
	return d;
}
/** A fake `vite build`: writes dist/index.html + an asset, returns ok. */
function fakeBuild(calls: string[]) {
	return async (dir: string) => {
		calls.push(dir);
		mkdirSync(join(dir, "dist", "assets"), { recursive: true });
		writeFileSync(join(dir, "dist", "index.html"), "<html><head><title>Built</title></head><body></body></html>");
		writeFileSync(join(dir, "dist", "assets", "app.js"), "console.log('built')");
		return { ok: true, distDir: "dist" };
	};
}

let n = 0;
beforeEach(() => { n += 1; });

describe("prepareOfflineBundle", () => {
	it("client-only SPA with no dist → builds on demand, bundles the built dist", async () => {
		const id = `spa-${n}`;
		writeViteSource(id);
		const calls: string[] = [];
		const r = await prepareOfflineBundle(fakeReg, workspace, id, 7007, fakeBuild(calls));
		expect(r.status).toBe("ok");
		expect(calls).toHaveLength(1);                       // built once
		if (r.status !== "ok") return;
		expect(r.bundle.entry).toBe("index.html");
		const paths = r.bundle.files.map((f) => f.path).sort();
		expect(paths).toEqual(["assets/app.js", "index.html"]);
		expect(r.bundle.files.find((f) => f.path === "index.html")?.content).toContain("Built");
	});

	it("fresh dist (source not changed since build) → NO rebuild", async () => {
		const id = `fresh-${n}`;
		const d = writeViteSource(id);
		const calls: string[] = [];
		await prepareOfflineBundle(fakeReg, workspace, id, 7007, fakeBuild(calls));  // first build
		expect(calls).toHaveLength(1);
		const r = await prepareOfflineBundle(fakeReg, workspace, id, 7007, fakeBuild(calls));  // second call
		expect(r.status).toBe("ok");
		expect(calls).toHaveLength(1);   // dist is fresh → not rebuilt
		void d;
	});

	it("UPDATED app (source newer than dist) → rebuilds so the download gets new pages", async () => {
		const id = `stale-${n}`;
		const d = writeViteSource(id);
		const calls: string[] = [];
		await prepareOfflineBundle(fakeReg, workspace, id, 7007, fakeBuild(calls));  // build v1
		expect(calls).toHaveLength(1);
		// Simulate an app update: bump a source file's mtime past the dist.
		const future = Date.now() / 1000 + 60;
		utimesSync(join(d, "src", "main.tsx"), future, future);
		const r = await prepareOfflineBundle(fakeReg, workspace, id, 7007, fakeBuild(calls));
		expect(r.status).toBe("ok");
		expect(calls).toHaveLength(2);   // rebuilt because source changed
	});

	it("build failure → blocked with an actionable reason, no bundle", async () => {
		const id = `buildfail-${n}`;
		writeViteSource(id);
		const failing = async () => ({ ok: false, error: "Rollup failed to resolve import './missing'" });
		const r = await prepareOfflineBundle(fakeReg, workspace, id, 7007, failing);
		expect(r.status).toBe("blocked");
		if (r.status !== "blocked") return;
		expect(r.reason).toContain("Couldn't build this app for offline use");
		expect(r.reason).toContain("Rollup failed to resolve import");
	});

	it("full-stack app (backend dev-server record) → blocked: needs the desktop", async () => {
		const id = `fullstack-${n}`;
		writeViteSource(id);
		// A registered backend is the full-stack signal.
		const recDir = join(dataDir, "dev-servers");
		mkdirSync(recDir, { recursive: true });
		writeFileSync(join(recDir, `${id}.json`), JSON.stringify({ appId: id, command: "node server.js", cwd: "/tmp", port: 5100, connector: `dev-${id}`, kind: "backend" }));
		const r = await prepareOfflineBundle(fakeReg, workspace, id, 7007, fakeBuild([]));
		expect(r.status).toBe("blocked");
		if (r.status !== "blocked") return;
		expect(r.reason).toContain("live backend");
	});

	it("server-rendered framework (Next) → blocked: needs the desktop", async () => {
		const id = `next-${n}`;
		const d = appDir(id);
		writeFileSync(join(d, "next.config.js"), "export default {};");
		writeFileSync(join(d, "package.json"), JSON.stringify({ name: id, dependencies: { next: "^15.0.0" } }));
		const r = await prepareOfflineBundle(fakeReg, workspace, id, 7007, fakeBuild([]));
		expect(r.status).toBe("blocked");
		if (r.status !== "blocked") return;
		expect(r.reason).toContain("server-rendered framework");
	});

	it("plain static HTML app → bundled as-is, no build", async () => {
		const id = `static-${n}`;
		const d = appDir(id);
		writeFileSync(join(d, "index.html"), "<html><body>hi</body></html>");  // no package.json
		const calls: string[] = [];
		const r = await prepareOfflineBundle(fakeReg, workspace, id, 7007, fakeBuild(calls));
		expect(r.status).toBe("ok");
		expect(calls).toHaveLength(0);   // static HTML needs no build
		if (r.status !== "ok") return;
		expect(r.bundle.files.find((f) => f.path === "index.html")?.content).toContain("hi");
	});
});
