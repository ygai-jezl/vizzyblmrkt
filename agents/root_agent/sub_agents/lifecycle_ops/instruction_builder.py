"""Dynamic instruction for the Lifecycle Ops sub-agent.

Prepends the operator language directive (the shared session `locale`, set by the
root agent's `[ctx:]` envelope callback) onto the static instruction, notes the
journey page the operator is chatting from, if any, and adds the Email style rule
when the brand has a style saved (`emailStyleConfigured`, written by every
get_lifecycle_context read). Where journey styles are on (`journeyStyleEnabled`,
written by the same reads and by the journey style tools), it adds the rule for one
journey's own look and points the Email style rule at it. Pure / ADK-free —
ReadonlyContext stays under TYPE_CHECKING — so it remains unit-testable without ADK.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from ...context.language import language_directive
from .prompts.instruction import (
    EMAIL_STYLE_ADDENDUM,
    EMAIL_STYLE_BRAND_LOOK,
    EMAIL_STYLE_JOURNEY_LOOK,
    JOURNEY_STYLE_ADDENDUM,
    LIFECYCLE_OPS_INSTRUCTION,
)

if TYPE_CHECKING:
    from google.adk.agents.readonly_context import ReadonlyContext

# A launch's welcome journey on the lifecycle engine (waitlistJourneyId in the app).
_LAUNCH_JOURNEY_PREFIX = "lcjw_"


def build_lifecycle_ops_instruction(ctx: "ReadonlyContext") -> str:
    """ADK invokes this each turn."""
    state = getattr(ctx, "state", None) if ctx else None
    locale = state.get("locale") if state else None
    parts = []
    directive = language_directive(locale)
    if directive:
        parts.append(directive)
    parts.append(LIFECYCLE_OPS_INSTRUCTION)
    journey_id = state.get("journeyId") if state else None
    if journey_id and str(journey_id).startswith(_LAUNCH_JOURNEY_PREFIX):
        # Its emails and steps are edited on its page (get_lifecycle_journey 404s for it):
        # from chat, only its look.
        parts.append(
            "# This conversation\n"
            f"The operator is on the page of journey {journey_id}, a launch's welcome journey. "
            "They edit its emails and steps on that page: get_lifecycle_journey and "
            "save_lifecycle_graph can't open a launch's journey, so don't call them for it. For "
            'its look ("give this journey a navy header"), use get_journey_email_style and '
            "set_journey_email_style, which use this journey when journey_id is empty."
        )
    elif journey_id:
        parts.append(
            "# This conversation\n"
            f"The operator is on the page of journey {journey_id} (connected product "
            f"{state.get('connectionId') or 'unknown'}). Requests to change \"this journey\" "
            "mean that one: read it with get_lifecycle_journey before editing."
        )
    journey_styles = bool(state and state.get("journeyStyleEnabled"))
    if state and state.get("emailStyleConfigured"):
        parts.append(
            EMAIL_STYLE_ADDENDUM.replace(EMAIL_STYLE_BRAND_LOOK, EMAIL_STYLE_JOURNEY_LOOK)
            if journey_styles
            else EMAIL_STYLE_ADDENDUM
        )
    if journey_styles:
        parts.append(JOURNEY_STYLE_ADDENDUM)
    return "\n\n".join(parts)
