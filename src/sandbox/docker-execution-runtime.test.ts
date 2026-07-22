import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  DockerCliExecutionRuntime,
  type DockerCommandRunner,
  type DockerContainerSpec,
} from "./docker-execution-runtime.js";

const digest = `sha256:${"a".repeat(64)}`;
const imageId = `sha256:${"b".repeat(64)}`;
const reference = `registry.example/lax-worker@${digest}`;
const containerId = "c".repeat(64);
const createdAt = "2026-07-21T12:00:00.000Z";
const networkId = "e".repeat(64);
const mountRoot = mkdtempSync(join(tmpdir(), "lax-docker-runtime-"));
const mountSource = join(mountRoot, "op-1");
writeFileSync(mountSource, "state");
afterAll(() => rmSync(mountRoot, { recursive: true, force: true }));

describe("DockerCliExecutionRuntime", () => {
  it("requires an exact digest pin and verifies the local image identity", async () => {
    const run = vi.fn<DockerCommandRunner>().mockResolvedValue({
      stdout: `${JSON.stringify([reference])}\n${imageId}\n`, stderr: "",
    });
    const runtime = new DockerCliExecutionRuntime(run, policy());

    await expect(runtime.resolvePinnedImage("registry.example/lax-worker:latest"))
      .rejects.toThrow("pinned by sha256");
    await expect(runtime.resolvePinnedImage(reference)).resolves.toEqual({
      reference, requestedDigest: digest, imageId,
    });
  });

  it("creates a non-root read-only container without a Docker socket", async () => {
    const run = vi.fn<DockerCommandRunner>()
      .mockResolvedValueOnce({ stdout: `${networkId}\nlax-egress\nbridge\nlocal\nfalse\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: `${containerId}\n`, stderr: "" })
      .mockResolvedValueOnce({
        stdout: `${containerId}\n${createdAt}\n${imageId}\nfalse\n0\n`, stderr: "",
      });
    const runtime = new DockerCliExecutionRuntime(run, policy());
    await expect(runtime.create(spec())).resolves.toEqual({
      containerId, createdAt, imageId, running: false, exitCode: 0,
    });

    const args = run.mock.calls[1][0];
    expect(args).toEqual(expect.arrayContaining([
      "--read-only", "--cap-drop", "ALL", "--user", "1000:1000",
      "--security-opt", "no-new-privileges:true", "--network", networkId,
    ]));
    expect(args.join(" ")).not.toContain("docker.sock");
  });

  it("rejects a Docker socket mount and never invokes Docker", async () => {
    const run = vi.fn<DockerCommandRunner>();
    const runtime = new DockerCliExecutionRuntime(run, policy());
    const input = spec();
    input.mounts = [{ source: "/var/run/docker.sock", target: "/tmp/daemon.sock", readOnly: false }];
    await expect(runtime.create(input)).rejects.toThrow("Docker socket mount is forbidden");
    expect(run).not.toHaveBeenCalled();
  });

  it("fails closed if inspect reports a different image id", async () => {
    const run = vi.fn<DockerCommandRunner>()
      .mockResolvedValueOnce({ stdout: `${networkId}\nlax-egress\nbridge\nlocal\nfalse\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: `${containerId}\n`, stderr: "" })
      .mockResolvedValueOnce({
        stdout: `${containerId}\n${createdAt}\nsha256:${"d".repeat(64)}\nfalse\n0\n`, stderr: "",
      })
      .mockResolvedValueOnce({ stdout: containerId, stderr: "" });
    await expect(new DockerCliExecutionRuntime(run, policy()).create(spec()))
      .rejects.toThrow("image identity changed");
    expect(run.mock.calls[3][0]).toEqual(["rm", "--force", containerId]);
  });

  it("rejects a same-name network with different security properties", async () => {
    const run = vi.fn<DockerCommandRunner>().mockResolvedValue({
      stdout: `${networkId}\nlax-egress\nmacvlan\nswarm\ntrue\n`, stderr: "",
    });
    await expect(new DockerCliExecutionRuntime(run, policy()).create(spec()))
      .rejects.toThrow("network properties are not approved");
    expect(run).toHaveBeenCalledOnce();
  });

  it.skipIf(process.platform !== "linux")(
    "holds the canonical mount inode until Docker start completes",
    async () => {
      writeFileSync(mountSource, "state");
      let heldSource = "";
      const run = vi.fn<DockerCommandRunner>()
        .mockResolvedValueOnce({ stdout: `${networkId}\nlax-egress\nbridge\nlocal\nfalse\n`, stderr: "" })
        .mockImplementationOnce(async (args) => {
          heldSource = /source=([^,]+)/.exec(args.join(" "))?.[1] ?? "";
          expect(heldSource).toMatch(/^\/proc\/\d+\/fd\/\d+$/);
          return { stdout: `${containerId}\n`, stderr: "" };
        })
        .mockResolvedValueOnce({ stdout: `${containerId}\n${createdAt}\n${imageId}\nfalse\n0\n`, stderr: "" })
        .mockImplementationOnce(async () => {
          expect(readFileSync(heldSource, "utf8")).toBe("state");
          return { stdout: containerId, stderr: "" };
        });
      const input = spec();
      input.mounts = [{ source: mountSource, target: "/var/lib/lax-op", readOnly: false }];
      const runtime = new DockerCliExecutionRuntime(run, policy());
      await runtime.create(input);
      rmSync(mountSource);
      writeFileSync(mountSource, "replacement");
      await runtime.start(containerId);
      expect(run.mock.calls[1][0].join(" ")).not.toContain(`source=${mountSource}`);
      expect(() => readFileSync(heldSource)).toThrow();
    },
  );

  it.skipIf(process.platform !== "linux")("walks mounts from the pinned approved root", async () => {
    const approved = join(mountRoot, "approved-race");
    const displaced = join(mountRoot, "approved-displaced");
    const replacement = join(mountRoot, "approved-replacement");
    const trigger = join(mountRoot, "approved-trigger");
    for (const path of [approved, replacement, trigger]) mkdirSync(path);
    writeFileSync(join(approved, "state"), "approved");
    writeFileSync(join(replacement, "state"), "attacker");
    const roots = [approved, trigger];
    Object.defineProperty(roots, 1, { get() {
      renameSync(approved, displaced);
      renameSync(replacement, approved);
      return trigger;
    } });
    let heldSource = "";
    const run = vi.fn<DockerCommandRunner>()
      .mockResolvedValueOnce({ stdout: `${networkId}\nlax-egress\nbridge\nlocal\nfalse\n`, stderr: "" })
      .mockImplementationOnce(async args => {
        heldSource = /source=([^,]+)/.exec(args.join(" "))?.[1] ?? "";
        expect(readFileSync(heldSource, "utf8")).toBe("approved");
        expect(readFileSync(join(approved, "state"), "utf8")).toBe("attacker");
        return { stdout: `${containerId}\n`, stderr: "" };
      })
      .mockResolvedValueOnce({ stdout: `${containerId}\n${createdAt}\n${imageId}\nfalse\n0\n`, stderr: "" })
      .mockResolvedValueOnce({ stdout: containerId, stderr: "" });
    const input = spec();
    input.mounts = [{ source: join(approved, "state"), target: "/var/lib/lax-op", readOnly: false }];
    const runtime = new DockerCliExecutionRuntime(run, { approvedMountRoots: roots,
      allowedNetwork: { name: "lax-egress", id: networkId } });
    await runtime.create(input);
    await runtime.start(containerId);
  });

  it.skipIf(process.platform !== "linux")("releases held mounts when Docker create fails", async () => {
    let heldSource = "";
    const run = vi.fn<DockerCommandRunner>()
      .mockResolvedValueOnce({ stdout: `${networkId}\nlax-egress\nbridge\nlocal\nfalse\n`, stderr: "" })
      .mockImplementationOnce(async args => {
        heldSource = /source=([^,]+)/.exec(args.join(" "))?.[1] ?? "";
        throw new Error("create failed");
      });
    const input = spec();
    input.mounts = [{ source: mountSource, target: "/var/lib/lax-op", readOnly: false }];

    await expect(new DockerCliExecutionRuntime(run, policy()).create(input)).rejects.toThrow("create failed");
    expect(() => readFileSync(heldSource)).toThrow();
  });

  it.skipIf(process.platform !== "linux")("releases held mounts when Docker start fails", async () => {
    let heldSource = "";
    const run = vi.fn<DockerCommandRunner>()
      .mockResolvedValueOnce({ stdout: `${networkId}\nlax-egress\nbridge\nlocal\nfalse\n`, stderr: "" })
      .mockImplementationOnce(async args => {
        heldSource = /source=([^,]+)/.exec(args.join(" "))?.[1] ?? "";
        return { stdout: `${containerId}\n`, stderr: "" };
      })
      .mockResolvedValueOnce({ stdout: `${containerId}\n${createdAt}\n${imageId}\nfalse\n0\n`, stderr: "" })
      .mockRejectedValueOnce(new Error("start failed"));
    const input = spec();
    input.mounts = [{ source: mountSource, target: "/var/lib/lax-op", readOnly: false }];
    const runtime = new DockerCliExecutionRuntime(run, policy());
    await runtime.create(input);

    await expect(runtime.start(containerId)).rejects.toThrow("start failed");
    expect(() => readFileSync(heldSource)).toThrow();
  });

  it.skipIf(process.platform === "linux")("fails closed for bind mounts without inode-stable handoff", async () => {
    const run = vi.fn<DockerCommandRunner>()
      .mockResolvedValueOnce({ stdout: `${networkId}\nlax-egress\nbridge\nlocal\nfalse\n`, stderr: "" });
    const input = spec();
    input.mounts = [{ source: mountSource, target: "/var/lib/lax-op", readOnly: false }];

    await expect(new DockerCliExecutionRuntime(run, policy()).create(input))
      .rejects.toThrow("inode-stable container bind mounts require a Linux host");
    expect(run).toHaveBeenCalledOnce();
  });

  it("rejects host networking and a zero memory fence", async () => {
    const run = vi.fn<DockerCommandRunner>();
    const runtime = new DockerCliExecutionRuntime(run, policy());
    await expect(runtime.create({ ...spec(), network: { name: "host" } }))
      .rejects.toThrow("network is not approved");
    await expect(runtime.create({ ...spec(), memoryLimit: "0g" }))
      .rejects.toThrow("invalid container memory limit");
    expect(run).not.toHaveBeenCalled();
  });
});

function spec(): DockerContainerSpec {
  return {
    name: "lax-op-abc",
    image: { reference, requestedDigest: digest, imageId },
    command: ["node", "/opt/lax/container-worker-entry.js"],
    environment: { LAX_OP_ID: "op-1" },
    mounts: [],
    network: { name: "lax-egress" },
    memoryLimit: "2g",
    pidsLimit: 256,
    labels: { "local-agent-x.op-id": "op-1" },
  };
}

function policy() {
  return { approvedMountRoots: [mountRoot], allowedNetwork: { name: "lax-egress", id: networkId } };
}
