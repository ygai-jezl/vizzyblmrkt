"""`get_image_style` and `suggest_image_style` FunctionTools: Vizzy reads and suggests the image style.

IMPORTANT (same as retrieve_knowledge.py): ADK resolves the parameter annotations
at runtime to find and strip the injected `tool_context`, so `ToolContext` must be
a real runtime import and this module must NOT use `from __future__ import
annotations`. The pure logic lives in image_style_client.py.
"""

from typing import Dict, Optional

from google.adk.tools import ToolContext

from . import image_style_client as client


def _state(tool_context: ToolContext) -> dict:
    return getattr(tool_context, "state", None) or {}


def get_image_style(tool_context: ToolContext) -> dict:
    """Read the brand's image style: the look every image Create makes starts from
    (social posts, blog heroes, eBook images, newsletter and launch email images).

    Returns `current` (the default style and any channel's own; null = the brand
    hasn't picked, so images look as they always did), `pending` (a suggestion
    waiting for an admin), `styles` (each style's id, label, hint, whether it's
    `built` yet, and whether it's drawn with exact words or painted with no words),
    `channels`, `canSuggest` (only admins can suggest) and the page `url`. Call this
    before answering about the image style or suggesting one. Anyone making an image
    can still pick another style for that image only.
    """
    return client.get_style(_state(tool_context))


def suggest_image_style(
    default_style: str,
    reason: str,
    brief: str,
    tool_context: ToolContext,
    channels: Optional[Dict[str, str]] = None,
) -> dict:
    """Suggest the brand's image style for an admin to review and apply.

    It is ONLY a suggestion: images don't change until an admin reviews and saves it
    on Brand › Image style. Never say it's live or applied. Only admins can suggest,
    and only a style get_image_style lists as `built`.

    Args:
        default_style: A style id from get_image_style's `styles` (like
            "headline_card" or "natural_photo"), the brand's default.
        reason: Why this style suits the brand, in one plain sentence (shown to the
            admin beside the suggestion). No dashes.
        brief: The operator's words, in a sentence.
        channels: Only where a channel should differ from the default: a map of
            channel ("blogHero", "linkedin", "x", "instagram", "newsletter", "ebook",
            "launchEmail") to a style id. Leave empty otherwise.

    Returns:
        A status dict to relay (includes a card with a "Review and apply" link).
    """
    return client.suggest_style(_state(tool_context), default_style, reason, brief, channels)
