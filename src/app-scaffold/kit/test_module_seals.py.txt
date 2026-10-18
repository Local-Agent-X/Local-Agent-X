"""Module boundaries, two kinds.

SEALS: code outside a sealed package may import it only through its public
modules. An agent can then learn a package from its __init__ alone, and a reach
into internals fails here instead of silently coupling two packages. Add a row
when a package gains a few outside importers (the codebase map shows importer
counts). If a name is missing from the public surface, export it there; don't
loosen the seal.

FORBIDDEN: a package that must never depend on another at all, by any path (the
UI never reaches the database). The layering rules ARCHITECTURE.md states in
prose become failing tests.
"""
import ast
import pathlib

import pytest

# The source root (the importable top-level package's parent), as a path from
# this file's directory: "../src" for the usual tests/ beside src/; "." when the
# test sits in the root itself.
SOURCE_ROOT = "../src"
SRC = (pathlib.Path(__file__).resolve().parent / SOURCE_ROOT).resolve()

# (dotted package, allowed public submodules relative to it; "" = the package itself)
SEALS: list[tuple[str, list[str]]] = [
    # ("app.billing", [""]),
]

# (dotted package that must not import, dotted package it must not import, the rule in words)
FORBIDDEN: list[tuple[str, str, str]] = [
    # ("app.ui", "app.db", "the UI reads data through app.api, never the database"),
]


def _is_module(dotted: str) -> bool:
    path = SRC.joinpath(*dotted.split("."))
    return path.is_dir() or path.with_suffix(".py").is_file()


def _imports(path: pathlib.Path):
    tree = ast.parse(path.read_text(encoding="utf8"))
    pkg_parts = path.relative_to(SRC).with_suffix("").parts[:-1]
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield node.lineno, alias.name
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            if node.level:
                anchor = pkg_parts[: len(pkg_parts) - node.level + 1]
                base = ".".join([*anchor, base] if base else anchor)
            yield node.lineno, base
            for alias in node.names:
                yield node.lineno, f"{base}.{alias.name}" if base else alias.name


@pytest.mark.parametrize("package,public", SEALS or [pytest.param(None, None, marks=pytest.mark.skip("no seals yet"))])
def test_module_is_imported_only_through_public_entries(package, public):
    allowed = {package if not p else f"{package}.{p}" for p in public}
    pkg_dir = SRC.joinpath(*package.split("."))
    violations = []
    for path in SRC.rglob("*.py"):
        if pkg_dir in path.parents:
            continue
        for lineno, name in _imports(path):
            if not (name == package or name.startswith(package + ".")):
                continue
            # `from pkg import Name` yields "pkg.Name": allowed when pkg is public and Name isn't a submodule.
            parent = name.rsplit(".", 1)[0]
            if name in allowed or (parent in allowed and not _is_module(name)):
                continue
            violations.append(f"{path.relative_to(SRC)}:{lineno} -> {name}")
    assert not violations, (
        f"Deep imports into {package} - import from {sorted(allowed)} "
        f"(export the name there if it is missing):\n  " + "\n  ".join(violations)
    )


@pytest.mark.parametrize("source,target,why", FORBIDDEN or [pytest.param(None, None, None, marks=pytest.mark.skip("no rules yet"))])
def test_forbidden_dependency_is_never_crossed(source, target, why):
    src_dir = SRC.joinpath(*source.split("."))
    crossings = [
        f"{path.relative_to(SRC)}:{lineno} -> {name}"
        for path in src_dir.rglob("*.py")
        for lineno, name in _imports(path)
        if name == target or name.startswith(target + ".")
    ]
    assert not crossings, f"{source} must not import {target}: {why}\n  " + "\n  ".join(crossings)
