"""`get_insights_summary` FunctionTool — Vizzy answers "how are we doing?" from real numbers.

IMPORTANT (same as retrieve_knowledge.py): ADK resolves the parameter annotations
at runtime to find and strip the injected `tool_context`, so `ToolContext` must be
a real runtime import and this module must NOT use `from __future__ import
annotations`. The pure logic lives in insights_client.py.
"""

from google.adk.tools import ToolContext

from .insights_client import get_summary


def get_insights_summary(tool_context: ToolContext) -> dict:
    """Get the brand's marketing numbers from Insights, as aggregates:

    - signups this week and last week, and the last 12 weeks;
    - where signups came from in the last 30 days (LinkedIn, X, newsletter, other
      content, search, referral, direct) and the utm_campaigns that brought them;
    - each automated email's sends, open rate and click rate, recent broadcasts,
      and the best email by click rate;
    - the Insights headline tiles, and the waitlist-to-product funnel when invites
      are on.

    Call this BEFORE answering any question about performance, results, trends,
    what's working, or which content or emails bring signups. Answer only from these
    numbers, say when a figure is estimated (see `sources.note`), and never invent
    one. Rates are fractions (0.42 means 42%).

    Returns:
        {"status": "success", "headline": [...], "signups": {...}, "sources": {...},
         "email": {...}, "funnel": {...} or null}, or a status dict to relay.
    """
    state = getattr(tool_context, "state", None) or {}
    return get_summary(state)
