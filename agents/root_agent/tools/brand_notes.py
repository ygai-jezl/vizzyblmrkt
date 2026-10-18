"""`get_brand_notes` and `suggest_brand_notes` FunctionTools: Vizzy reads What we've seen and files suggested notes.

IMPORTANT (same as brand_map.py): ADK resolves the parameter annotations at runtime to
find and strip the injected `tool_context`, so `ToolContext` must be a real runtime
import and this module must NOT use `from __future__ import annotations`. The pure logic
lives in brand_notes_client.py.
"""

from typing import List, Optional

from google.adk.tools import ToolContext

from . import brand_notes_client as client


def _state(tool_context: ToolContext) -> dict:
    return getattr(tool_context, "state", None) or {}


def get_brand_notes(tool_context: ToolContext, find: str = "") -> dict:
    """Read What we've seen: the brand's own first-hand notes that blog articles draw on.

    Returns how many notes are kept and how many wait for an admin, `kinds` (how many of each:
    customer_story, tested, mistake, objection, numbers, before_after, disagree), `fewest`
    (the kinds it has least of, which make the best interview questions) and `notes` (the
    newest kept ones, or the ones nearest `find`). Call this before suggesting a note or
    interviewing someone.

    Args:
        find: Words to find the notes nearest in meaning (e.g. "checking answers every day").
            Leave empty for the newest.
    """
    return client.get_notes(_state(tool_context), find)


def suggest_brand_notes(notes: List[str], tool_context: ToolContext, brief: Optional[str] = None) -> dict:
    """File notes on What we've seen as SUGGESTIONS an admin keeps.

    Use only the person's own words (lightly tidied, nothing added): a story, a test, a result,
    a mistake, an objection or an opinion they gave you. Never invent experience, people or
    figures. One story per note. Nothing is used by an article until an admin keeps it on
    Brand › What we've seen, so never say a note is in use.

    Args:
        notes: One to five notes, each "note" or "kind | note", where kind is customer_story,
            tested, mistake, objection, numbers, before_after or disagree
            (e.g. "tested | We ran the same question daily for a week and the brands named changed most days").
        brief: Optional, the person's request in a sentence (not sent; for your own reference).

    Returns:
        A status dict to relay (it says what was filed, and links to the page).
    """
    return client.suggest(_state(tool_context), notes)
