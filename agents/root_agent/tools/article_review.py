"""`review_article` FunctionTool: Vizzy starts or moves on a refresh review of a live article.

IMPORTANT (same as usage.py): ADK resolves the parameter annotations at runtime to find and strip
the injected `tool_context`, so `ToolContext` must be a real runtime import and this module must
NOT use `from __future__ import annotations`. The pure logic lives in article_review_client.py.
"""

from google.adk.tools import ToolContext

from . import article_review_client as client


def _state(tool_context: ToolContext) -> dict:
    return getattr(tool_context, "state", None) or {}


def review_article(tool_context: ToolContext, article_id: str, move_on: bool = True) -> dict:
    """Start a refresh review of one live blog article, or move the running one on a step.

    `article_id` is an article's `articleId` from `list_articles_due`. With `move_on` (the default)
    it starts a review if none is running and does its next step (one step can take a minute);
    with `move_on=False` it only says where the review is. Returns `review`: its `state`
    ("running", "ready for a person to look at", "nothing", "applied", "dismissed", "failed"),
    `now` (the step it is on), `changesProposed`, and `changes`, each with its `kind`, the words
    it `replaces`, the words it puts `with`, `why`, its `evidence` and whether it `movesUpdated`.
    Also `couldNotRead`, `reviewsLeftThisMonth` when one starts, `link` (the article in the app)
    and `meanings`. It never applies or dismisses a change: a person does that on the article.
    """
    return client.review_article(_state(tool_context), article_id, move_on)
