"""`get_brand_map` and `suggest_brand_map` FunctionTools — Vizzy reads the brand map and suggests changes.

IMPORTANT (same as retrieve_knowledge.py): ADK resolves the parameter annotations
at runtime to find and strip the injected `tool_context`, so `ToolContext` must be
a real runtime import and this module must NOT use `from __future__ import
annotations`. The pure logic lives in brand_map_client.py.
"""

from typing import List, Optional

from google.adk.tools import ToolContext

from . import brand_map_client as client


def _state(tool_context: ToolContext) -> dict:
    return getattr(tool_context, "state", None) or {}


def get_brand_map(tool_context: ToolContext) -> dict:
    """Read the brand map: one set of names and subjects every blog article is written from.

    Returns `map` (null = none yet) with `saved` (articles use the map only once an admin
    has saved it), `identity` (the brand's name, its category, what it is in a sentence,
    what it is not, names it avoids with what it says instead, its site and confirmed
    profile links), `subjects` (what it wants to be known for, each with the questions
    people ask) and `names` (its products, alternatives, integrations, audiences and use
    cases, with other spellings). `suggestions` says how many wait for an admin and what
    the latest are. When `statesKnown` is true, each question has a `state`: answered (a
    live page, in `answeredBy`), being written, planned or open. Call this before answering
    about the brand map or suggesting a change.
    """
    return client.get_map(_state(tool_context))


def suggest_brand_map(
    brief: str,
    tool_context: ToolContext,
    mode: str = "add",
    brand_name: str = "",
    category: str = "",
    statement: str = "",
    is_not: Optional[List[str]] = None,
    avoid: Optional[List[str]] = None,
    subjects: Optional[List[str]] = None,
    questions: Optional[List[str]] = None,
    names: Optional[List[str]] = None,
    aliases: Optional[List[str]] = None,
) -> dict:
    """Suggest changes to the brand map for an admin to accept, or research it.

    It ONLY files suggestions: nothing in the map changes until an admin accepts one on
    Brand › Brand map. Never say the map changed. Only admins can suggest. It never takes
    a link: profile links and home pages are added by a person on the page.

    Args:
        brief: The operator's words, in a sentence. It is kept as the reason.
        mode: "add" (default) to suggest what the operator said, or "research" to research
            the map from the brand's site and knowledge (about a minute), as the page's
            "Research again" does. With "research", leave the other fields empty.
        brand_name: What the brand is called. Empty = no change.
        category: What its category is called, exactly. Empty = no change.
        statement: What it is, in one sentence. Empty = no change.
        is_not: Things the brand is not, one per line (e.g. "A general SEO suite").
        avoid: Names it doesn't use, as "term | what it says instead"
            (e.g. "GEO tool | AI visibility tracking"), or just "term".
        subjects: Subjects it wants to be known for (aim for three to five in all).
        questions: Questions people ask, as "Subject | Question" (e.g.
            "Share of voice | How is share of voice measured?"). The subject is one on the
            map, or one suggested in this same call.
        names: Names it uses, as "Name | kind", where kind is product, alternative,
            integration, audience or use_case (e.g. "Rivalco | alternative").
        aliases: Other spellings of a name, as "Name | other spelling".

    Send only what the operator asked for.

    Returns:
        A status dict to relay (includes a card with a "Review and apply" link).
    """
    return client.suggest(
        _state(tool_context),
        mode,
        brief,
        brand_name=brand_name,
        category=category,
        statement=statement,
        is_not=is_not,
        avoid=avoid,
        subjects=subjects,
        questions=questions,
        names=names,
        aliases=aliases,
    )
