"""`list_articles_due` FunctionTool: Vizzy reads which live articles are due a refresh, and why.

IMPORTANT (same as usage.py): ADK resolves the parameter annotations at runtime to find and strip
the injected `tool_context`, so `ToolContext` must be a real runtime import and this module must
NOT use `from __future__ import annotations`. The pure logic lives in articles_due_client.py.
"""

from google.adk.tools import ToolContext

from . import articles_due_client as client


def _state(tool_context: ToolContext) -> dict:
    return getattr(tool_context, "state", None) or {}


def list_articles_due(tool_context: ToolContext) -> dict:
    """List this brand's live blog articles that are due, or soon due, a refresh, with why.

    Returns `articles`: each with its `title`, `liveAddress`, `state` ("due a refresh" or "review
    soon"), `dueAt`, `clockDays` (its refresh clock: 20, 30 or 45 days), `reasons` (in words: its
    age on the clock, falling Google clicks, just off page one, an old figure or source, dead
    links, new questions on its subject, no date on the page) and `link` (the article in the app).
    Also `articlesDue`, `articlesReviewSoon`, `articlesFresh`, `byClock` (live articles on each
    clock) and `lookedAt` (the watch's last daily look). `meanings` explains every number. Use it
    for "which articles need refreshing?", "is our share of voice article out of date?" or "how
    many articles are on each clock?". Read only: a person opens the article to refresh it or
    presses "Checked, nothing to change".
    """
    return client.list_articles_due(_state(tool_context))
