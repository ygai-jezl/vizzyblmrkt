"""`get_email_results` and `get_post_results` FunctionTools: Vizzy reads how emails and posts did.

IMPORTANT (same as search.py): ADK resolves the parameter annotations at runtime to find and
strip the injected `tool_context`, so `ToolContext` must be a real runtime import and this module
must NOT use `from __future__ import annotations`. The pure logic lives in results_client.py.
"""

from google.adk.tools import ToolContext

from . import results_client as client


def _state(tool_context: ToolContext) -> dict:
    return getattr(tool_context, "state", None) or {}


def get_email_results(tool_context: ToolContext, scope: str = "overview", id: str = "") -> dict:
    """Read how the brand's emails did, with the meaning of every number.

    `overview`: each email programme and broadcast with sends, open and click rates, plus totals
    from each email's own record (every open and click, bounces, deferrals, complaints). `launch`
    (id = the launch id): its sequences and broadcasts with delivered, unique opens and clicks and
    unsubscribes. `journey` (id = the journey id): each step's sends, opens, clicks, bounces and
    complaints. Every answer has `meanings` explaining each number (definition, grain, caveat):
    use them when you explain the figures, and say a rate is inflated by automatic opens where the
    meaning says so. Aggregates only, never a person. Read only.

    Args:
        scope: "overview", "launch" or "journey".
        id: The launch id or journey id, for "launch" or "journey".
    """
    return client.get_email_results(_state(tool_context), scope, id)


def get_post_results(tool_context: ToolContext, channel: str = "", days: int = 30, post: str = "") -> dict:
    """Read how the brand's LinkedIn and X posts did, with the meaning of every number.

    For each post published in the period: impressions, likes, comments, shares (and on X reposts,
    quotes and bookmarks; on LinkedIn clicks and LinkedIn's own engagement), and its engagement
    rate once it is 7 days old (`settled`). `totals` adds them up per channel. Every answer has
    `meanings` explaining each number. Read only.

    Args:
        channel: "linkedin" or "x" for one channel; leave empty for both.
        days: How far back to look, 1 to 365 (default 30).
        post: One post's id, to read just that post.
    """
    return client.get_post_results(_state(tool_context), channel, days, post)
