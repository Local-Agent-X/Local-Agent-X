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


class OpenClawAptFallback(AptSecurityFallback, OpenClaw):
    pass


class CodexAptFallback(AptSecurityFallback, Codex):
    pass
