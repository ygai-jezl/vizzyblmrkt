"""`get_audience_counts` FunctionTool: Vizzy answers "how big is my audience?" from real counts.

IMPORTANT (same as insights_summary.py): ADK resolves the parameter annotations
at runtime to find and strip the injected `tool_context`, so `ToolContext` must be
a real runtime import and this module must NOT use `from __future__ import
annotations`. The pure logic lives in audience_client.py.
"""

from google.adk.tools import ToolContext

from .audience_client import get_counts


def get_audience_counts(tool_context: ToolContext) -> dict:
    """Count the brand's audience: one person per email address across every launch
    and connected product. Counts only, never a name or an address:

    - everyone, and how many we can email;
    - how many are on each launch, and how many joined from the brand's own site;
    - how many use each product, and how many are at each stage in it (new,
      onboarding, stuck, activated, and quiet, which overlaps the others).

    Call this BEFORE answering how many people the brand has, how many it can
    email, or how many are stuck, quiet or activated in a product. Answer only from
    these numbers. It can't name or find a person; for one person, point the
    operator to Audience › People.

    Returns:
        {"status": "success", "people": n, "canEmail": n, "fromYourSite": n,
         "launches": [{"name", "people"}], "products": [{"name", "people", "stages"}],
         "note": "..."}, or a status dict to relay.
    """
    state = getattr(tool_context, "state", None) or {}
    return get_counts(state)
