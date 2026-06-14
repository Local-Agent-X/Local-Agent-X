"""AgentDojo defense element that routes every tool call through LAX's real
whole-stack guard (the Node bridge), and every tool output through LAX's real
content sanitizer, before they reach the model.

Drop-in replacement for AgentDojo's ToolsExecutor: same control flow, with two
bridge round-trips added per tool call:
  - BEFORE execution: POST /guard/tool-call -> allow / block (kernel + lineage +
    canary + threat). A block returns an error to the model instead of executing.
  - AFTER execution:  POST /guard/tool-output -> sanitized text that replaces what
    the model sees (delimiting + injection warning + taint recording).

run_id is set per episode by the orchestrator so the bridge can isolate per-run
firewall/taint/canary state.
"""

import json
import urllib.request
from ast import literal_eval
from collections.abc import Sequence

from agentdojo.agent_pipeline.tool_execution import ToolsExecutor, is_string_list, tool_result_to_str
from agentdojo.agent_pipeline.llms.google_llm import EMPTY_FUNCTION_NAME
from agentdojo.functions_runtime import EmptyEnv, Env, FunctionsRuntime
from agentdojo.types import ChatMessage, ChatToolResultMessage, text_content_block_from_string


def _post(url: str, payload: dict, timeout: int = 180) -> dict:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _jsonable(obj):
    try:
        json.dumps(obj)
        return obj
    except (TypeError, ValueError):
        return {k: str(v) for k, v in obj.items()} if isinstance(obj, dict) else str(obj)


class AriToolFirewall(ToolsExecutor):
    def __init__(self, bridge_url: str, output_formatter=tool_result_to_str):
        super().__init__(output_formatter)
        self.bridge_url = bridge_url.rstrip("/")
        self.run_id = ""

    def _err(self, tc, msg: str) -> ChatToolResultMessage:
        return ChatToolResultMessage(
            role="tool",
            content=[text_content_block_from_string("")],
            tool_call_id=tc.id,
            tool_call=tc,
            error=msg,
        )

    def query(self, query, runtime, env=EmptyEnv(), messages=(), extra_args={}):
        if len(messages) == 0 or messages[-1]["role"] != "assistant":
            return query, runtime, env, messages, extra_args
        tool_calls = messages[-1]["tool_calls"]
        if tool_calls is None or len(tool_calls) == 0:
            return query, runtime, env, messages, extra_args

        results = []
        for tc in tool_calls:
            if tc.function == EMPTY_FUNCTION_NAME:
                results.append(self._err(tc, "Empty function name provided. Provide a valid function name."))
                continue
            if tc.function not in (t.name for t in runtime.functions.values()):
                results.append(self._err(tc, f"Invalid tool {tc.function} provided."))
                continue
            for k, v in tc.args.items():
                if isinstance(v, str) and is_string_list(v):
                    tc.args[k] = literal_eval(v)

            # GATE: run the tool call through the whole-stack guard.
            try:
                verdict = _post(f"{self.bridge_url}/guard/tool-call",
                                {"runId": self.run_id, "tool": tc.function, "args": _jsonable(tc.args)})
            except Exception:
                verdict = {"allowed": True}  # fail-open: a bridge hiccup must not masquerade as a block
            if not verdict.get("allowed", True):
                stage = verdict.get("stage", "policy")
                reason = (verdict.get("reason") or "denied")[:200]
                results.append(self._err(tc, f"[BLOCKED by {stage}] {reason}"))
                continue

            tool_result, error = runtime.run_function(env, tc.function, tc.args)
            formatted = self.output_formatter(tool_result)

            # SANITIZE: route the output through LAX's sanitizer before the model sees it.
            if error is None:
                try:
                    g = _post(f"{self.bridge_url}/guard/tool-output",
                              {"runId": self.run_id, "tool": tc.function, "args": _jsonable(tc.args), "output": formatted})
                    formatted = g.get("output", formatted)
                except Exception:
                    pass

            results.append(ChatToolResultMessage(
                role="tool",
                content=[text_content_block_from_string(formatted)],
                tool_call_id=tc.id,
                tool_call=tc,
                error=error,
            ))
        return query, runtime, env, [*messages, *results], extra_args
