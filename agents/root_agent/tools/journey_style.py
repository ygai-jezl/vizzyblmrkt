"""`get_journey_email_style` and `set_journey_email_style` FunctionTools — Vizzy reads and sets one journey's own look.

IMPORTANT (same as email_style.py): ADK resolves the parameter annotations at
runtime to find and strip the injected `tool_context`, so `ToolContext` must be
a real runtime import and this module must NOT use `from __future__ import
annotations`. The pure logic lives in journey_style_client.py.

Registered on the root agent and on Lifecycle Ops (which journey pages go to).
"""

from google.adk.tools import ToolContext

from . import journey_style_client as client


def _state(tool_context: ToolContext) -> dict:
    return getattr(tool_context, "state", None) or {}


def get_journey_email_style(tool_context: ToolContext, journey_id: str = "", campaign_id: str = "") -> dict:
    """Read one journey's own Email style: whether its emails wear the brand's Email
    style or the journey's own header and button colours, in its draft and live.

    The journey is the one the operator is on (a product journey, or a launch's
    welcome journey), else the welcome journey of the launch in view. journey_id, or
    campaign_id (a launch's id, for its welcome journey), picks another.

    Returns `journey` (its name, kind "product" or "launch_welcome", status and
    launch), `canEdit` (only admins can set it), `brand` (the brand's Email style, for
    comparison; null = the plain look with no header band), `palette` (the brand's
    colours to pick from), `draft` and `live` (mode "brand", or "custom" with
    headerColor and buttonColor; `live` is null before the first publish),
    `changedSincePublish` and a `note` to follow. `headerOptions: true` means the
    styles also carry headerGradientColor (null = a solid header) and headerText
    ("auto", "white" or "black"), and set_journey_email_style can change them;
    without it, they aren't switched on here yet.

    Call this before setting a journey's look. If `journey` isn't the one the
    operator means, ask which. If `canEdit` is false, say only an admin can set it
    instead of calling set_journey_email_style.
    """
    return client.get_style(_state(tool_context), journey_id, campaign_id)


def set_journey_email_style(
    mode: str,
    tool_context: ToolContext,
    header_color: str = "",
    button_color: str = "",
    header_gradient_color: str = "",
    solid_header: bool = False,
    header_text_color: str = "",
    journey_id: str = "",
    campaign_id: str = "",
) -> dict:
    """Set one journey's own look in its DRAFT: the brand's Email style, or the
    journey's own header and button colours (on the colour header with the brand's
    logo, name and theme, never the brand's header image).

    It saves the draft only: the journey's emails change when an admin publishes it,
    and from then on every email it sends wears it. Never say it's live or applied.
    Only admins can set it.

    Args:
        mode: "custom" for the journey's own colours, or "brand" to go back to the
            brand's Email style (send no colours with it).
        header_color: The header's colour as a hex like "#1b2a4a" (turn a colour
            name into a hex). Empty = keep the draft's (the brand's, when the journey
            is on the brand's style).
        button_color: The button colour as a hex. Empty = keep, as for header_color.
        header_gradient_color: Only when get_journey_email_style says `headerOptions`.
            The header fades from header_color (top left) to this hex (bottom right).
            Empty = keep.
        solid_header: True to remove the gradient, so the header is one colour again.
        header_text_color: Only when get_journey_email_style says `headerOptions`.
            "white" or "black" for the name on the header, or "auto" to go back to
            whichever reads better. Empty = keep.
        journey_id: Empty = the journey the operator is on. Only to set another one.
        campaign_id: A launch's id, to set that launch's welcome journey. Empty = the
            journey the operator is on, else the launch in view.

    Send only what the operator asked to change.

    Returns:
        A status dict to relay (includes a card with an "Open journey" link).
    """
    return client.set_style(
        _state(tool_context),
        mode,
        header_color,
        button_color,
        header_gradient_color,
        solid_header,
        header_text_color,
        journey_id,
        campaign_id,
    )
