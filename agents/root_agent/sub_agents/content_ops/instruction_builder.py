"""Dynamic instruction for the Content Ops sub-agent.

Prepends the operator language directive (the shared session `locale`, set by the
root agent's `[ctx:]` envelope callback) and notes the programme / plan on screen.
Pure / ADK-free — ReadonlyContext stays under TYPE_CHECKING — so it's unit-testable
without ADK.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from ...context.language import language_directive
from .prompts.instruction import CONTENT_OPS_INSTRUCTION

if TYPE_CHECKING:
    from google.adk.agents.readonly_context import ReadonlyContext


def build_content_ops_instruction(ctx: "ReadonlyContext") -> str:
    """ADK invokes this each turn."""
    state = getattr(ctx, "state", None) if ctx else None
    locale = state.get("locale") if state else None
    parts = []
    directive = language_directive(locale)
    if directive:
        parts.append(directive)
    parts.append(CONTENT_OPS_INSTRUCTION)
    workspace_id = state.get("workspaceId") if state else None
    plan_id = state.get("planId") if state else None
    if workspace_id:
        where = f"programme {workspace_id}" + (f", plan {plan_id}" if plan_id else "")
        parts.append(
            "# This conversation\n"
            f"The operator is looking at {where}. \"This programme\" means that one"
            + (", and \"this plan\" means that plan: read it with get_content_plan before editing." if plan_id else ".")
        )
    return "\n\n".join(parts)
