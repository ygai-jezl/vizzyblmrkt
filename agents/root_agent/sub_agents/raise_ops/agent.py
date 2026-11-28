"""Raise Ops Agent: Vizzy's specialist for raising money.

It drafts DECKS for investors and PACKS for lenders, and changes them slide by slide, saving each
change as a new DRAFT version. The root agent (Vizzy) delegates to it for pitch decks, lender packs,
a deck's speaker notes (its talk track) or changing one slide.

Its tools call back into the Next.js app with the signed capability token: read the brand's decks
and save drafts through the canvas endpoint. Sending or sharing a deck stays human only, so no tool
confirmation is needed here.
"""

from __future__ import annotations

from google.adk.agents import LlmAgent

from .instruction_builder import build_raise_ops_instruction
from .tools.raise_tools import draft_raise_doc, get_raise_doc, revise_raise_doc
from ...model_config import DEFAULT_MODEL

raise_ops_agent = LlmAgent(
    name="raise_ops_agent",
    model=DEFAULT_MODEL,
    description=(
        "Raise Ops Agent: drafts and revises decks for investors and packs for lenders from what "
        "YouGrow knows about the brand, slide by slide, saving drafts only. Delegate here for pitch "
        "decks, lender packs, a deck's speaker notes or changing one slide."
    ),
    instruction=build_raise_ops_instruction,
    tools=[draft_raise_doc, get_raise_doc, revise_raise_doc],
)
