"""Single source of truth for the ADK agents' model id.

Both the root orchestrator (agent.py) and the campaign_ops sub-agent import
DEFAULT_MODEL from here, so the default literal lives in ONE place — models change
often. It is overridable at runtime via the ROOT_AGENT_MODEL env var (set on the
deployed engine in .agent_engine_config.json / deploy.sh) with no code change.

This module imports nothing from agent.py, so either agent module can import it
without a circular dependency (agent.py imports the campaign_ops sub-agent).
"""

from __future__ import annotations

import os

# Flash for speed/cost; thinking is selected per-request via the [mode:] prefix.
DEFAULT_MODEL = os.environ.get("ROOT_AGENT_MODEL", "gemini-3.6-flash")
