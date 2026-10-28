// The destinations an inline program spells as literals, and the ones it does
// not (which fail closed). The local forms are what Terminal-Bench 2.0
// (2026-10-20) refused: a VM's control socket, a port check in Python.
import { afterEach, describe, expect, it } from "vitest";
import { inlineProgramDestinations, inlinePrograms } from "./shell-inline-destinations.js";
import { _setInterfaceAddressesForTests } from "./loopback-grant.js";

const py = (program: string) => inlineProgramDestinations(`python3 -c "${program}"`);
const node = (program: string) => inlineProgramDestinations(`node -e "${program}"`);

describe("inlinePrograms", () => {
  it("is each argument after an eval flag, in every position", () => {
    expect(inlinePrograms(`python3 -c 'print(1)' && node -e 'x()'`)).toEqual(["print(1)", "x()"]);
    expect(inlinePrograms("python3 script.py -c")).toEqual([]);
  });
});

describe("inlineProgramDestinations", () => {
  const local: Array<[string, ReturnType<typeof py>]> = [
    ["import socket; s=socket.socket(); s.connect(('127.0.0.1', 5901)); print(s.recv(12))", { kind: "local", ports: ["5901"], unixSockets: [] }],
    ["import socket; s=socket.socket(); print(s.connect_ex(('127.0.0.1',5328)))", { kind: "local", ports: ["5328"], unixSockets: [] }],
    ["import socket; s=socket.socket(socket.AF_UNIX); s.connect('/tmp/qemu-qmp.sock')", { kind: "local", ports: [], unixSockets: ["/tmp/qemu-qmp.sock"] }],
    ["import urllib.request; print(urllib.request.urlopen('http://localhost:8443/').read())", { kind: "local", ports: ["8443"], unixSockets: [] }],
    ["import requests; print(requests.get('http://127.0.0.1:5000/health').status_code)", { kind: "local", ports: ["5000"], unixSockets: [] }],
    ["import socket; socket.create_connection(('localhost', 6379), timeout=2)", { kind: "local", ports: ["6379"], unixSockets: [] }],
    // Terminal-Bench (2026-10-20): the destination bound to a name first, and
    // http.client's (host, port) as two arguments.
    ["import urllib.request; req = urllib.request.Request('https://localhost:8443/', method='GET'); resp = urllib.request.urlopen(req, timeout=5)", { kind: "local", ports: ["8443"], unixSockets: [] }],
    ["import requests; url = 'http://127.0.0.1:5000/health'; print(requests.get(url).status_code)", { kind: "local", ports: ["5000"], unixSockets: [] }],
    ["import http.client; conn = http.client.HTTPConnection('127.0.0.1', 6080, timeout=5); conn.request('HEAD', '/')", { kind: "local", ports: ["6080"], unixSockets: [] }],
  ];
  for (const [program, expected] of local) it(`local: ${program.slice(0, 60)}`, () => expect(py(program)).toEqual(expected));

  it("reads node's forms", () => {
    expect(node("require('net').connect(80, 'localhost')")).toEqual({ kind: "local", ports: ["80"], unixSockets: [] });
    expect(node("require('net').connect({ port: 6379, host: '127.0.0.1' })")).toEqual({ kind: "local", ports: ["6379"], unixSockets: [] });
    expect(node("fetch('http://localhost:3000/api')")).toEqual({ kind: "local", ports: ["3000"], unixSockets: [] });
  });

  const unknown = [
    "import socket; s=socket.socket(); s.connect((host, port))",
    "import requests; requests.get(url)",
    "import socket; s=socket.socket(); s.connect(('evil.test', 443))",
    "import urllib.request; urllib.request.urlopen(f'http://localhost:{p}/')",
    "import socket; s=socket.socket(); s.connect(('127.0.0.1', 80)); import requests; requests.get(url)",
    // A name bound twice, or to something other than a literal, is not a literal.
    "import requests; url = 'http://localhost:1/'; url = input(); requests.get(url)",
    "import requests; url = base + '/x'; requests.get(url)",
    "import http.client; conn = http.client.HTTPConnection('evil.test', 80)",
  ];
  for (const program of unknown) it(`unknown: ${program.slice(0, 60)}`, () => expect(py(program)).toEqual({ kind: "unknown" }));
  it("is unknown for node reaching out", () => expect(node("fetch('https://evil.test')")).toEqual({ kind: "unknown" }));

  it("names nothing for a program with no destination call", () => {
    expect(py("print(2+2)")).toEqual({ kind: "none" });
    expect(py("import socket; socket.socket()")).toEqual({ kind: "none" });
  });
});

// TB2 2026-10-28: install-windows-3.11 checked three pages of its own server in
// a loop; hf-model-inference checked a server bound to every interface at the
// container's own address.
describe("a loop over literals, and this machine's own interface address", () => {
  afterEach(() => _setInterfaceAddressesForTests(null));

  it("reads every literal a loop variable takes", () => {
    const loop = 'import urllib.request\nfor url in ["http://127.0.0.1:80/", "http://127.0.0.1:80/vnc.html", "http://localhost:6080/core/rfb.js"]:\n    r = urllib.request.urlopen(url, timeout=5)';
    expect(inlineProgramDestinations("python3 - <<'EOF' x", [loop])).toEqual({ kind: "local", ports: ["80", "6080"], unixSockets: [] });
    expect(node("for (const u of ['http://localhost:3000/a', 'http://localhost:3000/b']) fetch(u)")).toEqual({ kind: "local", ports: ["3000"], unixSockets: [] });
  });

  it("is unknown when the loop's list holds anything but literals, or one off this machine", () => {
    for (const loop of [
      'import urllib.request\nfor url in ["http://127.0.0.1/", "https://evil.test/"]:\n    urllib.request.urlopen(url)',
      'import urllib.request\nfor url in [base + "/a"]:\n    urllib.request.urlopen(url)',
      'import urllib.request\nfor url in urls:\n    urllib.request.urlopen(url)',
      'import urllib.request\nurl = "http://127.0.0.1/"\nfor url in ["https://evil.test/"]:\n    urllib.request.urlopen(url)',
    ]) expect(inlineProgramDestinations("python3 -", [loop]), loop).toEqual({ kind: "unknown" });
  });

  it("a literal address one of this machine's interfaces holds is this machine; another private address is not", () => {
    _setInterfaceAddressesForTests(() => ["127.0.0.1", "172.28.0.2", "fe80::1"]);
    const call = (host: string) => py(`import urllib.request; print(urllib.request.urlopen('http://${host}:5000/sentiment', data=b'x').read())`);
    expect(call("172.28.0.2")).toEqual({ kind: "local", ports: ["5000"], unixSockets: [] });
    expect(call("[fe80::1]")).toEqual({ kind: "local", ports: ["5000"], unixSockets: [] });
    expect(call("172.28.0.3")).toEqual({ kind: "unknown" });
  });
});
