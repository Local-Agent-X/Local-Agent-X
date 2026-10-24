"""Harbor agent that runs Local Agent X (LAX) on a Terminal-Bench task.

An installed agent, like Harbor's own claude-code and codex agents: LAX runs
inside the task container, so it works under the same conditions they do.

    harbor run -d terminal-bench/terminal-bench@4.0.0 -e docker \
        -a lax_agent:LaxAgent -m lmstudio/qwen3.6-27b

with this folder on PYTHONPATH and LAX_TB_BUNDLE pointing at the Linux bundle
that bundle.mjs builds. All the work happens in drive.mjs; this class only
copies the bundle in and calls it. See README.md.
"""

import os
import shlex
from pathlib import Path
from typing import override

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.model_connection import ModelConnectionSpec
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

INSTALL_DIR = "/installed-agent/lax"
NODE = f"{INSTALL_DIR}/.node/bin/node"
INSTRUCTION_PATH = "/installed-agent/instruction.txt"
LOGS = "/logs/agent"
DEFAULT_BUNDLE = Path.home() / ".cache" / "lax-terminal-bench" / "lax-linux-x64.tgz"

# Passed through to drive.mjs when set on the host.
FORWARDED_ENV = ("LAX_TB_LOCAL_URL", "LAX_TB_MODE")


class LaxAgent(BaseInstalledAgent):
    capabilities = AgentCapabilities()
    # LAX picks its provider from the model prefix and reaches a local model
    # itself; Harbor has no key to resolve or inject.
    MODEL_CONNECTION = ModelConnectionSpec(passthrough=True)

    @staticmethod
    @override
    def name() -> str:
        return "lax"

    @override
    def get_version_command(self) -> str | None:
        return f"cat {INSTALL_DIR}/dist/.builtref"

    @override
    def parse_version(self, stdout: str) -> str:
        return stdout.strip()[:12]

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        bundle = Path(os.environ.get("LAX_TB_BUNDLE", DEFAULT_BUNDLE))
        if not bundle.is_file():
            raise RuntimeError(
                f"LAX bundle not found at {bundle}; build it with "
                "`node eval/terminal-bench/bundle.mjs` or set LAX_TB_BUNDLE"
            )
        # tar and gzip are essential packages on the Debian/Ubuntu images tasks
        # use, and Harbor's installer has no entry for either, so check, not install.
        probe = await environment.exec(command="command -v tar && command -v gzip", user="root")
        if probe.return_code != 0:
            raise RuntimeError("the task image has no tar or gzip; the LAX bundle cannot be unpacked")
        await environment.upload_file(bundle, "/installed-agent/lax.tgz")
        owner = environment.default_user
        chown = f" && chown -R {shlex.quote(str(owner))} {INSTALL_DIR}" if owner is not None else ""
        await self.exec_as_root(
            environment,
            command=(
                f"mkdir -p {INSTALL_DIR} && tar -xzf /installed-agent/lax.tgz -C {INSTALL_DIR} "
                f"&& rm /installed-agent/lax.tgz{chown} && {NODE} --version"
            ),
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        pass

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name:
            raise ValueError("pass a model as <provider>/<model>, e.g. -m lmstudio/qwen3.6-27b")
        await self._upload_config_text(
            environment,
            content=instruction,
            remote_path=INSTRUCTION_PATH,
            filename="instruction.txt",
        )
        env = {name: os.environ[name] for name in FORWARDED_ENV if os.environ.get(name)}
        await self.exec_as_agent(
            environment,
            command=(
                f"mkdir -p {LOGS} && {NODE} {INSTALL_DIR}/eval/terminal-bench/drive.mjs "
                f"--model {shlex.quote(self.model_name)} "
                f"--instruction-file {INSTRUCTION_PATH} "
                f"--out {LOGS}/lax-result.json --server-log {LOGS}/lax-server.log "
                f"2>&1 | tee {LOGS}/lax.txt"
            ),
            env=env or None,
        )
