"""Harbor agents whose setup survives a Debian release that has reached end of
life, whose security updates moved to archive.debian.org.

Harbor installs an agent's system tools (curl, git, ...) with `apt-get update
&& apt-get install`. On Debian bullseye images (the qemu-* tasks, bullseye's
end of life 2026-08) deb.debian.org still serves a bullseye-security index
but answers 404 for the packages it names (2026-10-21: curl, git, libexpat1),
so every installed agent that needs curl fails before the model sees the
task, while LAX, which brings its own tools, does not. Dropping the security
suite does not work: the image already holds security versions, and apt will
not downgrade them. On that failure this points the security suite at
archive.debian.org, which serves the same packages, and installs again. A
setup that works is untouched, so every harness gets the same task
environment it got before.

    harbor run ... -a apt_fallback:OpenClawAptFallback --ak version=2026.8.35 -m openai/<model>
    harbor run ... -a apt_fallback:OpenClawNode24AptFallback --ak version=2026.10.7 -m openai/<model>
    harbor run ... -a apt_fallback:CodexAptFallback -m openai/<model>
"""

from harbor.agents.installed.base import NonZeroAgentExitCodeError
from harbor.agents.installed.codex import Codex
from harbor.agents.installed.openclaw import OpenClaw
from harbor.environments.base import BaseEnvironment

# Repoints every one-line apt source for Debian's security mirror at the
# archive; exits 1 when there is none, so a failure with another cause is
# raised as it was.
SECURITY_TO_ARCHIVE = (
    "files=$(grep -lE '^deb https?://(deb|security)\\.debian\\.org/debian-security' "
    "/etc/apt/sources.list /etc/apt/sources.list.d/*.list 2>/dev/null || true); "
    "[ -n \"$files\" ] && sed -i -E "
    "'s#^deb (https?://)(deb|security)\\.debian\\.org/debian-security#deb \\1archive.debian.org/debian-security#' $files"
)


class AptSecurityFallback:
    async def ensure_system_dependencies(
        self, environment: BaseEnvironment, dependencies: tuple[str, ...]
    ) -> None:
        try:
            await super().ensure_system_dependencies(environment, dependencies)
        except NonZeroAgentExitCodeError:
            moved = await environment.exec(command=SECURITY_TO_ARCHIVE, user="root")
            if moved.return_code != 0:
                raise
            self.logger.warning("apt failed on the security mirror; installing again from archive.debian.org")
            await super().ensure_system_dependencies(environment, dependencies)


# Would Harbor's install of curl fail on this image? Fetches the packages into
# a scratch cache it then removes, so nothing is installed and the image is as
# it was, apart from the package index `apt-get update` refreshes, as Harbor's
# install refreshes it too. Succeeds without fetching when curl is installed.
CURL_FETCH_PROBE = (
    "probe=$(mktemp -d) && mkdir -p $probe/partial && apt-get update -qq "
    "&& apt-get install -y -qq --download-only -o Dir::Cache::archives=$probe curl; "
    "rc=$?; rm -rf $probe; exit $rc"
)


async def repoint_where_install_would_fail(environment: BaseEnvironment, logger) -> None:
    """For an agent that installs nothing with apt (LAX brings its own tools):
    leave the image's apt sources as every other harness leaves them, so the
    task's own test.sh, which installs curl with apt before it grades, works
    for it too. An agent Harbor installs curl for fails that install on an
    end-of-life image and AptSecurityFallback repoints it; the same failure,
    probed without installing, repoints this one. A working image is untouched."""
    probe = await environment.exec(command=CURL_FETCH_PROBE, user="root")
    if probe.return_code == 0:
        return
    moved = await environment.exec(command=SECURITY_TO_ARCHIVE, user="root")
    if moved.return_code == 0:
        logger.warning("apt fails on the security mirror; pointed it at archive.debian.org, as the other harnesses' setup does")


class OpenClawAptFallback(AptSecurityFallback, OpenClaw):
    pass


def _on_node24(command: str) -> str:
    return command.replace("nvm install 22", "nvm install 24").replace("nvm use 22", "nvm use 24")


class OpenClawNode24AptFallback(OpenClawAptFallback):
    """OpenClaw from 2026.9 needs Node >= 24.22.1, and Harbor's adapter installs
    and runs it on Node 22 (`nvm install 22`, `nvm use 22`), so the race ran
    2026.8.35, the newest that starts on 22. Every command it sends through
    exec_as_agent, the agent's own run included, gets Node 24 instead.

        harbor run ... -a apt_fallback:OpenClawNode24AptFallback --ak version=2026.10.7 --ak thinking=medium -m openai/<model>
    """

    def get_version_command(self) -> str | None:
        command = super().get_version_command()
        return _on_node24(command) if command else command

    async def exec_as_agent(self, environment: BaseEnvironment, command: str, *args, **kwargs):
        return await super().exec_as_agent(environment, _on_node24(command), *args, **kwargs)

    def _normalize_provider_models_schema(self, cfg: dict) -> None:
        """OpenClaw offers thinking levels only for a model its catalog marks
        `reasoning`, and the entry Harbor writes for the selected model holds
        only its id and name, so `--thinking medium` failed before the first
        turn ("Use one of: off, ultra", qwen3.8, 2026-10-24). A run that asks
        for thinking marks the selected model as reasoning."""
        super()._normalize_provider_models_schema(cfg)
        if self.options.thinking in (None, "off"):
            return
        provider_cfg = cfg.get("models", {}).get("providers", {}).get(self._model_provider() or "", {})
        for model in provider_cfg.get("models", []):
            if model.get("id") == self.model_name:
                model.setdefault("reasoning", True)


class CodexAptFallback(AptSecurityFallback, Codex):
    pass
