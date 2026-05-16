#!/usr/bin/env bash
# Local Agent X — macOS double-click installer.
# Finder runs this in Terminal; we just hand off to install.sh so there's
# one source of truth for the actual install steps.
exec "$(dirname "$0")/install.sh"
