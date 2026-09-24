"""`draft_invite_wave` FunctionTool — a thin ADK wrapper over canvas_client.

Like build_journey.py, this module must NOT use `from __future__ import
annotations`: ADK resolves the parameter annotations at runtime to strip the
injected `tool_context`. The pure logic lives in canvas_client.py.
"""

from google.adk.tools import ToolContext

from .canvas_client import draft_invite_wave_via_canvas


def draft_invite_wave(
    campaign_id: str,
    brief: str,
    tool_context: ToolContext,
    size: int = 0,
    expires_in_days: int = 0,
    wave_id: str = "",
) -> dict:
    """Draft an invite of a launch's waitlist into the connected product.

    Use this when the operator wants to invite their waitlist (or its top N
    people) into their product now that it's ready. It saves a DRAFT invite wave
    with on-brand email copy; it never sends. Each invited person leaves the
    waitlist when the operator presses Send invites on the launch's Invites page.

    Args:
        campaign_id: The launch whose waitlist to invite. If empty, the launch the
            operator is looking at is used.
        brief: The operator's words about tone or what to say, for the copywriter.
        size: How many people, from the top of the waitlist (1-1000). 0 = up to 100.
        expires_in_days: How long each invite link works (7-90). 0 = 30 days.
        wave_id: Only to rewrite an existing DRAFT wave.

    Returns:
        A status dict to relay (includes a card the chat shows with an Open link).
    """
    state = getattr(tool_context, "state", None) or {}
    return draft_invite_wave_via_canvas(state, campaign_id, brief, size, expires_in_days, wave_id)
