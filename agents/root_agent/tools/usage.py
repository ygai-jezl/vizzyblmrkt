"""`get_usage` FunctionTool: Vizzy reads what the brand used this month, against its limits.

IMPORTANT (same as next_up.py): ADK resolves the parameter annotations at runtime to find and
strip the injected `tool_context`, so `ToolContext` must be a real runtime import and this module
must NOT use `from __future__ import annotations`. The pure logic lives in usage_client.py.
"""

from google.adk.tools import ToolContext

from . import usage_client as client


def _state(tool_context: ToolContext) -> dict:
    return getattr(tool_context, "state", None) or {}


def get_usage(tool_context: ToolContext) -> dict:
    """Read what this brand used this month of each paid resource and costly feature.

    Returns `thisBrand`: one row each for web searches for research, AI model use (tokens, with
    `byModel`), images made, Google lookups for Next up, competitor articles read and autopilot
    drafts, each with `usedThisMonth`, `monthlyLimit` (null means no limit), `leftThisMonth` and
    `byFeature` (what used it). An organisation's owners also get `organisation.thisMonth`, the
    totals across its brands. `meanings` explains every number. Use it for "how much have we used?",
    "how many web searches are left?" or "why did research stop searching Google?". Read only:
    limits and plans are changed by whoever runs this copy of YouGrow.
    """
    return client.get_usage(_state(tool_context))
