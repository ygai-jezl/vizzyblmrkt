"""`get_email_style` and `suggest_email_style` FunctionTools — Vizzy reads and suggests the Email style.

IMPORTANT (same as retrieve_knowledge.py): ADK resolves the parameter annotations
at runtime to find and strip the injected `tool_context`, so `ToolContext` must be
a real runtime import and this module must NOT use `from __future__ import
annotations`. The pure logic lives in email_style_client.py.
"""

from google.adk.tools import ToolContext

from . import email_style_client as client


def _state(tool_context: ToolContext) -> dict:
    return getattr(tool_context, "state", None) or {}


def get_email_style(tool_context: ToolContext) -> dict:
    """Read the brand's Email style: the logo, company name, header colour and button
    colour shared by every branded email (lifecycle, launch welcome, invites, newsletters).

    Returns `current` (what emails wear now; null = the plain default look, with no
    header band), `pending` (a suggestion waiting for an admin to review), `fromBrandKit`
    (what "Use brand kit" would pick, with notes), the `logos` an email can show,
    `canSuggest` (only admins can suggest) and the page `url`. Call this before
    answering about the email style or suggesting a change. If `canSuggest` is false,
    say only an admin can suggest one instead of calling suggest_email_style.
    """
    return client.get_style(_state(tool_context))


def suggest_email_style(
    mode: str,
    brief: str,
    tool_context: ToolContext,
    header_color: str = "",
    button_color: str = "",
    logo: str = "",
    company_name: str = "",
    hide_company_name: bool = False,
) -> dict:
    """Suggest an Email style for an admin to review and apply.

    It is ONLY a suggestion: emails don't change until an admin reviews and saves it
    on Brand › Email style. Never say it's live or applied. Only admins can suggest.

    Args:
        mode: "brand_kit" to start from the brand kit (e.g. "use my brand kit for my
            emails"), or "edit" to change the pending suggestion, else the saved style.
        brief: The operator's words, in a sentence.
        header_color: The band's colour as a hex like "#1b2a4a" (turn a colour name
            into a hex). Empty = keep.
        button_color: The button colour as a hex. Empty = keep.
        logo: "primary", "none", or a logo id from get_email_style. Empty = keep.
        company_name: The name shown beside the logo. Empty = keep.
        hide_company_name: True to show the logo alone, with no name.

    Send only what the operator asked to change.

    Returns:
        A status dict to relay (includes a card with a "Review and apply" link).
    """
    return client.suggest_style(
        _state(tool_context), mode, brief, header_color, button_color, logo, company_name, hide_company_name
    )
