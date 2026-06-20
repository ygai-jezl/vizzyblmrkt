"""Pytest configuration for root-agent-py tests.

The source files use relative-up imports (e.g. `from ..agent_logging.logger
import logger`). At deploy time `adk deploy agent_engine` wraps the directory in
a parent package so those resolve. Locally there's no wrapper, so we synthesize
one: register a fake parent package whose `__path__` points at the package root,
then pre-import the subpackages under it. Tests import via the synthetic parent
(e.g. `from root_agent_pkg.callbacks.context_envelope import _extract_envelope`).

The callbacks keep their `google.adk` imports under TYPE_CHECKING, so these
imports succeed even without ADK installed (ADK 2.0 needs Python 3.10+).
"""

import importlib
import sys
import types
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
_PKG_NAME = "root_agent_pkg"

if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

if _PKG_NAME not in sys.modules:
    pkg = types.ModuleType(_PKG_NAME)
    pkg.__path__ = [str(_ROOT)]
    sys.modules[_PKG_NAME] = pkg

    for sub in ("agent_logging", "callbacks", "context", "prompts", "sub_agents"):
        if (_ROOT / sub / "__init__.py").exists():
            importlib.import_module(f"{_PKG_NAME}.{sub}")
