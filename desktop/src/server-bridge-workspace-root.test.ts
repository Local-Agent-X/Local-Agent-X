/**
 * The server's "lax:workspace-root" reaches the file opener.
 *
 * Main opens a workspace file the user clicks from the path the server
 * announces at boot (open-workspace-file.ts). Before, it guessed
 * <projectRoot>/workspace, and on a machine whose workspace is in Documents
 * every click on a deck there did nothing (2026-11-23).
 */
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import { describe, expect, it, vi } from "vitest";

const setWorkspaceRoot = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({ BrowserWindow: class {}, shell: {} }));
vi.mock("./server-bridge-browser", () => ({
	handleBrowserBridgeMessage: vi.fn(),
	isBrowserBridgeMessage: () => false,
	wireBrowserEgressEvaluator: () => {},
}));
vi.mock("./screen-capture-native", () => ({ captureScreenInMain: vi.fn() }));
vi.mock("./android-view", () => ({ handleAndroidFrameMessage: vi.fn() }));
vi.mock("./open-workspace-file", () => ({ setWorkspaceRoot }));

import { attachServerBridge } from "./server-bridge";

describe("lax:workspace-root", () => {
	it("hands the announced workspace to the file opener", () => {
		const proc = new EventEmitter() as unknown as ChildProcess;
		attachServerBridge(proc, { onRestartServer: () => {}, onRelaunchApp: () => {} });
		proc.emit("message", { type: "lax:workspace-root", path: "C:\\Users\\me\\Documents\\Local Agent X\\workspace" });
		expect(setWorkspaceRoot).toHaveBeenCalledWith("C:\\Users\\me\\Documents\\Local Agent X\\workspace");
	});
});
