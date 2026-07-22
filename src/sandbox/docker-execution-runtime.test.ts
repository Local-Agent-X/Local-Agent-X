import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const mountLink = join(mountRoot, "op-link");
let canSymlink = true;
try { symlinkSync(mountSource, mountLink, "file"); } catch { canSymlink = false; }
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

  it.skipIf(!canSymlink || process.platform !== "linux")(
    "holds the canonical mount inode across Docker create",
    async () => {
      const replacement = join(mountRoot, "replacement");
      writeFileSync(replacement, "replacement");
      const run = vi.fn<DockerCommandRunner>()
        .mockResolvedValueOnce({ stdout: `${networkId}\nlax-egress\nbridge\nlocal\nfalse\n`, stderr: "" })
        .mockImplementationOnce(async (args) => {
          rmSync(mountLink);
          symlinkSync(replacement, mountLink, "file");
          const source = /source=([^,]+)/.exec(args.join(" "))?.[1];
          expect(source).toMatch(/^\/proc\/\d+\/fd\/\d+$/);
          expect(readFileSync(source!, "utf8")).toBe("state");
          return { stdout: `${containerId}\n`, stderr: "" };
        })
        .mockResolvedValueOnce({ stdout: `${containerId}\n${createdAt}\n${imageId}\nfalse\n0\n`, stderr: "" });
      const input = spec();
      input.mounts = [{ source: mountLink, target: "/var/lib/lax-op", readOnly: false }];
      await new DockerCliExecutionRuntime(run, policy()).create(input);
      expect(run.mock.calls[1][0].join(" ")).not.toContain(`source=${mountLink}`);
    },
  );

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
