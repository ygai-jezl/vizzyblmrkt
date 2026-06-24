"""Dynamic instruction for the Campaign Ops sub-agent.

Prepends the operator language directive (the shared session `locale`, set by the
root agent's `[ctx:]` envelope callback) onto the static instruction so the
specialist's relayed text matches the operator's language. Pure / ADK-free —
ReadonlyContext stays under TYPE_CHECKING — so it remains unit-testable without ADK.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from ...context.language import language_directive
from .prompts.instruction import CAMPAIGN_OPS_INSTRUCTION

if TYPE_CHECKING:
    from google.adk.agents.readonly_context import ReadonlyContext


def build_campaign_ops_instruction(ctx: "ReadonlyContext") -> str:
    """ADK invokes this each turn. Falls back to the base instruction for English."""
    state = getattr(ctx, "state", None) if ctx else None
    locale = state.get("locale") if state else None
    directive = language_directive(locale)
    if directive:
        return f"{directive}\n\n{CAMPAIGN_OPS_INSTRUCTION}"
    return CAMPAIGN_OPS_INSTRUCTION
