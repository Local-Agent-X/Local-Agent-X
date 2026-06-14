#!/usr/bin/env python
"""Orchestrate ARI-kernel × AgentDojo runs.

Drives AgentDojo's agent through the Node bridge:
  - the model is served by the bridge's OpenAI-compatible shim (claude via OAuth);
    AgentDojo's stock openai client is pointed at it via OPENAI_BASE_URL.
  - every tool call/output is routed through the bridge's whole-stack guard by the
    AriToolFirewall pipeline element.

We drive the per-episode loop ourselves (instead of AgentDojo's batch runner) so we
can set the run_id, open/close the bridge's per-run state, and post a live verdict
after each episode.

Polarity (verified): suite.run_task_with_pipeline returns (utility, security) where
security==True means the ATTACK SUCCEEDED. So defended = not security; ASR = security.

Usage:
  python run_bench.py --configs off,faithful,sanitize-all --suites banking,slack,travel,workspace
  python run_bench.py --suites banking --max-user-tasks 1 --max-injection-tasks 1   # smoke
"""
import argparse
import json
import os
import sys
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

BRIDGE = os.environ.get("BENCH_BRIDGE", "http://127.0.0.1:8900").rstrip("/")
os.environ.setdefault("OPENAI_API_KEY", "bench-dummy")
# LLM endpoint: defaults to the bridge's claude shim; set BENCH_LLM_BASE_URL to
# point at another OpenAI-compatible server (e.g. ollama http://localhost:11434/v1).
# The guard always stays on BRIDGE — LLM and guard are independent endpoints.
os.environ["OPENAI_BASE_URL"] = os.environ.get("BENCH_LLM_BASE_URL", BRIDGE + "/v1")

from agentdojo.task_suite.load_suites import get_suite  # noqa: E402
from agentdojo.agent_pipeline.agent_pipeline import AgentPipeline, get_llm, load_system_message  # noqa: E402
from agentdojo.agent_pipeline.basic_elements import InitQuery, SystemMessage  # noqa: E402
from agentdojo.agent_pipeline.tool_execution import ToolsExecutionLoop  # noqa: E402
from agentdojo.attacks.attack_registry import load_attack  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ari_defense import AriToolFirewall  # noqa: E402


def post(path: str, payload: dict) -> dict:
    try:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(BRIDGE + path, data=data, headers={"content-type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:
        print(f"  [bridge post {path} failed: {e}]")
        return {"error": str(e)}


def default_system_message() -> str:
    for name in ("default", None):
        try:
            return load_system_message(name)
        except Exception:
            continue
    return "You are an AI assistant that helps the user by using the available tools."


def build_pipeline(config: str, model: str, fw: AriToolFirewall) -> AgentPipeline:
    llm = get_llm("openai", model, None, "tool")
    loop = ToolsExecutionLoop([fw, llm])
    pipe = AgentPipeline([SystemMessage(default_system_message()), InitQuery(), llm, loop])
    # Name MUST contain a model name AgentDojo recognizes — the important_instructions
    # attack personalizes the injection with it ("...you are Claude..."). We drive
    # Claude, so "Claude" is both required and faithful.
    pipe.name = f"ari-{config}-claude-3-5-sonnet-20241022"
    return pipe


_print_lock = threading.Lock()


def run_episode(spec):
    """Self-contained so episodes can run concurrently: each builds its own
    firewall + pipeline (fresh run_id) — no shared mutable state across threads."""
    config, suite_name, version, model, attack_name, ut_id, inj_id = spec
    suite = get_suite(version, suite_name)
    ut = suite.get_user_task_by_id(ut_id)
    inj = suite.get_injection_task_by_id(inj_id) if inj_id else None
    fw = AriToolFirewall(BRIDGE)
    pipe = build_pipeline(config, model, fw)
    attack = load_attack(attack_name, suite, pipe)

    rid = f"{config}|{suite_name}|{ut.ID}|{inj_id or 'none'}"
    fw.run_id = rid
    post("/run/begin", {"runId": rid, "config": config, "suite": suite_name})
    injections = attack.attack(ut, inj) if inj is not None else {}
    errored = False
    util = sec = False
    try:
        util, sec = suite.run_task_with_pipeline(pipe, ut, inj, injections)
    except Exception as e:
        errored = True
        with _print_lock:
            print(f"    ERROR {rid}: {str(e)[:140]}")
    post("/run/end", {"runId": rid})

    if inj is None:
        post("/score", {"config": config, "suite": suite_name, "utility_passed": bool(util),
                        "security_passed": None, "errored": errored})
        tag = "benign-util" + ("=ok" if util else "=fail")
    else:
        defended = (None if errored else (not bool(sec)))
        post("/score", {"config": config, "suite": suite_name, "utility_passed": bool(util),
                        "security_passed": defended, "errored": errored})
        tag = ("ERR" if errored else ("DEFENDED" if defended else "ATTACK-WON"))
    with _print_lock:
        print(f"  [{config}/{suite_name}] {ut.ID}{('+' + inj_id) if inj_id else ''}: util={bool(util)} {tag}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--configs", default="off,faithful,sanitize-all")
    ap.add_argument("--suites", default="banking,slack,travel,workspace")
    ap.add_argument("--version", default="v1.2.2")
    ap.add_argument("--attack", default="important_instructions")
    ap.add_argument("--model", default=os.environ.get("BENCH_MODEL", "sonnet"))
    ap.add_argument("--max-user-tasks", type=int, default=0)       # 0 = all
    ap.add_argument("--max-injection-tasks", type=int, default=0)  # 0 = all
    ap.add_argument("--no-benign", action="store_true", help="skip the no-injection utility episodes")
    ap.add_argument("--workers", type=int, default=6, help="concurrent episodes (each = its own claude process)")
    args = ap.parse_args()

    configs = [c.strip() for c in args.configs.split(",") if c.strip()]
    suites = [s.strip() for s in args.suites.split(",") if s.strip()]

    # Build the full episode list up front (each spec is self-contained).
    specs = []
    for config in configs:
        for suite_name in suites:
            suite = get_suite(args.version, suite_name)
            uts = list(suite.user_tasks.keys())[: args.max_user_tasks] if args.max_user_tasks else list(suite.user_tasks.keys())
            injs = list(suite.injection_tasks.keys())[: args.max_injection_tasks] if args.max_injection_tasks else list(suite.injection_tasks.keys())
            for ut_id in uts:
                if not args.no_benign:
                    specs.append((config, suite_name, args.version, args.model, args.attack, ut_id, None))
                for inj_id in injs:
                    specs.append((config, suite_name, args.version, args.model, args.attack, ut_id, inj_id))

    total = len(specs)
    print(f"== {total} episodes · configs={configs} · suites={suites} · workers={args.workers} · model={args.model} ==")
    print(f"== live scoreboard: {BRIDGE}/scoreboard ==")
    done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = [ex.submit(run_episode, s) for s in specs]
        for _ in as_completed(futures):
            done += 1
            if done % 10 == 0 or done == total:
                with _print_lock:
                    print(f"  ... {done}/{total} episodes done")
    print("DONE — scoreboard:", BRIDGE + "/scoreboard")


if __name__ == "__main__":
    main()
