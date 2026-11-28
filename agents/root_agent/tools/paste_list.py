"""`paste_list_propose` FunctionTool: Vizzy reads a pasted list into one Review card an admin adds.

IMPORTANT (same as new_person.py): ADK resolves the parameter annotations at runtime to find and
strip the injected `tool_context`, so `ToolContext` must be a real runtime import and this module
must NOT use `from __future__ import annotations`. The pure logic lives in paste_list_client.py.
It sits on the root agent beside new_person_propose: adding people isn't about the person in view.
"""

from google.adk.tools import ToolContext

from . import paste_list_client as client


def paste_list_propose(tool_context: ToolContext, text: str, source: str = "") -> dict:
    """Read a list the operator pasted (rows from a sheet or a CSV file, header row first) into one card in Review, for an admin to add.

    Pass the rows exactly as pasted: never retype, reorder, add, complete or invent rows. Ask once
    "Where is this list from?" if they haven't said, and pass their answer as source. The app's
    code reads the rows, not you: a row with an email or a phone becomes a person, a row with only
    a firm's web address a company, and anything else is left out with its reason. Up to 50 rows.
    Nobody is added until an admin opens the card and adds them, everyone starts at Not yet for
    marketing emails, and you can never record that someone agreed.

    Args:
        text: The rows exactly as the operator pasted them, header row first.
        source: The operator's answer to "Where is this list from?", in their words.

    Returns:
        A status dict to relay, with a card the chat shows; left out rows come by row number.
        "needs_source" means ask where the list is from, then call again.
    """
    state = getattr(tool_context, "state", None) or {}
    return client.propose(state, text, source)
