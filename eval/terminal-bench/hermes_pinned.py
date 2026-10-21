"""Harbor's Hermes agent, installed from one Hermes release end to end.

Harbor 0.24's Hermes adapter always downloads install.sh from Hermes' `main`
branch, which since Hermes v0.21 sets up a package manager (`pm`) an older
release does not have, and it then runs `hermes version`, a subcommand no
Hermes release has (the flag is `hermes --version`), so neither the latest
Hermes nor a pinned one installs (2026-10-20). This fetches install.sh from
the same tag it checks out and asks for the version with the flag, so a
pinned release installs as it shipped. Everything else is Harbor's adapter,
unchanged.

    harbor run ... -a hermes_pinned:HermesPinned --ak version=v2026.9.24 -m openai/<model>
"""

from typing import override

from harbor.agents.installed.hermes import Hermes
from harbor.environments.base import BaseEnvironment


class HermesPinned(Hermes):
    @override
    def get_version_command(self) -> str | None:
        return 'export PATH="$HOME/.local/bin:$PATH"; hermes --version'

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        if not self._version:
            raise ValueError("HermesPinned needs --ak version=<hermes tag>")
        await self.ensure_system_dependencies(
            environment, ("curl", "git", "ripgrep", "xz")
        )
        tag = self._version
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/{tag}/scripts/install.sh"
                f" | bash -s -- --skip-setup --branch {tag} && "
                'export PATH="$HOME/.local/bin:$PATH" && '
                'export HERMES_HOME="${HERMES_HOME:-/tmp/hermes}" && '
                'mkdir -p "$HERMES_HOME" "$HERMES_HOME/sessions" "$HERMES_HOME/skills" "$HERMES_HOME/memories" && '
                "hermes --version"
            ),
        )
