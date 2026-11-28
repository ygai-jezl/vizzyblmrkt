"""Dynamic instruction for the Raise Ops sub-agent.

Prepends the operator language directive (the shared session `locale`, set by the root agent's
`[ctx:]` envelope callback) and notes the deck on screen (`raiseDocId`, while Vizzy can work on
decks). Appends what the brand told Vizzy about its business when the root has it cached
(context/business_profile.py). Pure / ADK-free (ReadonlyContext stays under TYPE_CHECKING), so it's
unit-testable without ADK.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from ...context.business_profile import profile_block_for
from ...context.language import language_directive
from .prompts.instruction import RAISE_OPS_INSTRUCTION

if TYPE_CHECKING:
    from google.adk.agents.readonly_context import ReadonlyContext

_DECK_ID = re.compile(r"^rd_[a-z0-9]{12}$")


def deck_in_view(state: "dict | None") -> str:
    """The deck on screen, or "" (the envelope sends "" once the operator leaves a deck)."""
    value = (state or {}).get("raiseDocId")
    return value if isinstance(value, str) and _DECK_ID.match(value) else ""


def build_raise_ops_instruction(ctx: "ReadonlyContext") -> str:
    """ADK invokes this each turn."""
    state = getattr(ctx, "state", None) if ctx else None
    locale = state.get("locale") if state else None
    parts = []
    directive = language_directive(locale)
    if directive:
        parts.append(directive)
    parts.append(RAISE_OPS_INSTRUCTION)
    doc_id = deck_in_view(state)
    if doc_id:
        parts.append(
            "# This conversation\n"
            f"The operator is looking at deck {doc_id}. \"This deck\" and \"this slide\" mean that one: read it with get_raise_doc first."
        )
    profile = profile_block_for(state)
    if profile:
        parts.append(profile)
    return "\n\n".join(parts)
