"""Vizzybl Marketing root orchestrator agent package.

`adk deploy agent_engine` discovers `root_agent` via this import.
"""

from . import _project_fix  # noqa: F401  MUST be first — fixes GOOGLE_CLOUD_PROJECT before google-auth
from . import agent  # noqa: F401
