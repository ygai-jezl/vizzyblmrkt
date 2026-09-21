"""Dynamic instruction for the Lifecycle Ops sub-agent.

Prepends the operator language directive (the shared session `locale`, set by the
root agent's `[ctx:]` envelope callback) onto the static instruction, and notes the
journey page the operator is chatting from, if any. Pure / ADK-free —
ReadonlyContext stays under TYPE_CHECKING — so it remains unit-testable without ADK.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from ...context.language import language_directive
from .prompts.instruction import LIFECYCLE_OPS_INSTRUCTION

if TYPE_CHECKING:
    from google.adk.agents.readonly_context import ReadonlyContext


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
    if journey_id:
        parts.append(
            "# This conversation\n"
            f"The operator is on the page of journey {journey_id} (connected product "
            f"{state.get('connectionId') or 'unknown'}). Requests to change \"this journey\" "
            "mean that one: read it with get_lifecycle_journey before editing."
        )
    return "\n\n".join(parts)
