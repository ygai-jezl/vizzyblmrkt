"""`get_learning` FunctionTool: Vizzy reads what YouGrow learned for this brand, and where it stalls.

IMPORTANT (same as settings_history.py): ADK resolves the parameter annotations at runtime to find
and strip the injected `tool_context`, so `ToolContext` must be a real runtime import and this
module must NOT use `from __future__ import annotations`. The pure logic lives in learning_client.py.
"""

from typing import List, Optional

from google.adk.tools import ToolContext

from . import learning_client as client


def _state(tool_context: ToolContext) -> dict:
    return getattr(tool_context, "state", None) or {}


def get_learning(tool_context: ToolContext, kinds: Optional[List[str]] = None, all_kinds: bool = False, days: int = 0) -> dict:
    """Read what YouGrow learned for this brand and how its team answered what YouGrow made, by kind.

    Without arguments it covers the last 90 days and lists `kinds`, one per kind of thing YouGrow
    made for the brand in that time, learning kinds first. Each has its `label`, its `line` (learns,
    own, gap, none or fleet) with `how` it learns or why it doesn't, `status` and `statusWords` (how
    far learning got), `stuck` (where it stalled over the last 4 weeks, with the learner's most
    common reason in words), `counts` (made, kept, edited, declined, voted, liked, remade, undone),
    `shares` for written things (keptShare, editShare, declineShare, unusedShare), or `unanswered`
    (why nothing lets the team keep, change or turn it down yet, so it has no shares), `learner` (what a
    learner learned or refused, and why), and for the image looks (`image_style`) `byKind` and
    `looks`, each look in use with its version, who set it and its votes. For a look's words and its
    checks in words, call get_image_style. `countsAcrossBrands` says whether the brand is in the
    counts across brands, and `imageLearning` whether image learning is paused. `meanings` and
    `countWords` say what every number means. Use it for "what has YouGrow learned for us?", "is
    learning working?" or "why isn't Edit mode learning?". Counts only, never another brand's. Read
    only: people undo, pause or forget looks on Brand › Image style, and turn the counts across
    brands off in Settings › General.

    Args:
        kinds: kinds to read even if nothing was made, by key or label as `kinds` or a person names
            them ("Edit mode", "Post images", "next_up"); up to 20.
        all_kinds: true to list every kind YouGrow has, made or not.
        days: how far back, from 7 to 182; leave it out for 90.

    Returns:
        {"status": "success", "kinds": [...], "notFound": [...], "moreKinds": n, "note": "..."},
        or a status dict to relay.
    """
    return client.get_learning(_state(tool_context), kinds=kinds, all_kinds=all_kinds, days=days)
