#!/usr/bin/env bash
# Local Agent X — macOS double-click installer.
# Finder runs this in Terminal; we just hand off to install.sh so there's
# one source of truth for the actual install steps.
# NOTE: also serves as an xcode-avoidance workaround — Finder spawns a clean
# Terminal.app login shell, which sidesteps the xcrun → Xcode.app launch
# that hits when install.sh is run from a terminal that's been touched by
# other dev tooling. Don't consolidate.
exec "$(dirname "$0")/install.sh"
