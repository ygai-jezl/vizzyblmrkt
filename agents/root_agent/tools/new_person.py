"""`new_person_propose` FunctionTool: Vizzy fills in the New person form for an admin to confirm.

IMPORTANT (same as audience_counts.py): ADK resolves the parameter annotations at runtime to
find and strip the injected `tool_context`, so `ToolContext` must be a real runtime import and
this module must NOT use `from __future__ import annotations`. The pure logic lives in
new_person_client.py. It sits on the root agent: adding someone isn't about the person in view.
"""

from typing import Optional

from google.adk.tools import ToolContext

from . import new_person_client as client


def new_person_propose(
    tool_context: ToolContext,
    email: str = "",
    phone: str = "",
    first_name: str = "",
    last_name: str = "",
    fields: Optional[dict] = None,
) -> dict:
    """Fill in the New person form with what the operator told you, for an admin to confirm.

    Nobody is added until an admin opens the form (from the card or Review), checks it, says
    how the person agreed to emails, and confirms. You can never record that they agreed. What
    you send is kept until then, or for at most 7 days. Pass only what the operator gave you,
    and never ask for contact details they didn't offer.

    Args:
        email: Their email address, as the operator gave it. An email or a phone is needed.
        phone: Their phone number, if the operator gave one.
        first_name: Their first name, if given.
        last_name: Their last name, if given.
        fields: The brand's own fields the operator mentioned, by field name: an option's name
            for a select or status, a list of option names for a multi select, true or false,
            a number, whole minor units for currency (1250 is 12.50 in GBP, and 1250 yen in JPY,
            which has no minor unit), or a day as YYYY-MM-DD.
            Other fields are left for the admin to type.

    Returns:
        A status dict to relay, with a card the chat shows (its link opens the form). "existing"
        means they're already in People: point the operator to their page.
    """
    state = getattr(tool_context, "state", None) or {}
    return client.propose(state, email, phone, first_name, last_name, fields)
