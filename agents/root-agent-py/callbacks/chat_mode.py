"""Apply chat mode (fast vs thinking) to the model request.

Reads a `[mode:fast]` or `[mode:thinking]` directive from the start of the user
message, sets `thinking_config` accordingly, and strips the directive before the
model sees it.

- fast      -> thinking_budget=0   (disable thinking)
- thinking  -> thinking_budget=-1  (dynamic / unlimited budget) + include thoughts
- (none)    -> leave Gemini default

Ported from the sibling supervisor. ADK types are under TYPE_CHECKING and the
`google.genai` import is deferred into the function body, so `_strip_mode_directive`
is unit-testable without ADK / genai installed.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Literal, Optional, Tuple

from ..agent_logging.logger import logger

if TYPE_CHECKING:
    from google.adk.agents.callback_context import CallbackContext
    from google.adk.models.llm_request import LlmRequest
    from google.adk.models.llm_response import LlmResponse

ChatMode = Literal["fast", "thinking"]

_MODE_RE = re.compile(r"^\s*\[mode:(fast|thinking)\]\s*", re.IGNORECASE)


def _strip_mode_directive(text: str) -> Tuple[str, Optional[str]]:
    m = _MODE_RE.match(text)
    if not m:
        return text, None
    mode = m.group(1).lower()
    cleaned = _MODE_RE.sub("", text, count=1)
    return cleaned, mode


async def apply_chat_mode(
    callback_context: "CallbackContext",
    llm_request: "LlmRequest",
) -> "Optional[LlmResponse]":
    """Parse `[mode:X]` from the latest user message and configure thinking_config."""
    from google.genai import types as genai_types  # deferred: keeps helper importable

    contents = getattr(llm_request, "contents", None) or []
    if not contents:
        return None

    mode: Optional[str] = None
    for content in reversed(contents):
        if getattr(content, "role", None) != "user":
            continue
        parts = getattr(content, "parts", None) or []
        for part in parts:
            text = getattr(part, "text", None)
            if not text:
                continue
            cleaned, found = _strip_mode_directive(text)
            if found:
                part.text = cleaned  # mutate in place — Gemini won't see the directive
                mode = found
            break  # only inspect the first text part of the latest user msg
        break

    if mode is None:
        return None

    config = getattr(llm_request, "config", None)
    if config is None:
        config = genai_types.GenerateContentConfig()
        llm_request.config = config

    if mode == "fast":
        config.thinking_config = genai_types.ThinkingConfig(
            thinking_budget=0,
            include_thoughts=False,
        )
    else:  # thinking
        config.thinking_config = genai_types.ThinkingConfig(
            thinking_budget=-1,  # dynamic / unlimited
            include_thoughts=True,
        )

    state = getattr(callback_context, "state", None)
    tenant_id = state.get("tenantId", "unknown") if state else "unknown"
    logger.info("Applied chat mode", mode=mode, tenant_id=tenant_id)
    return None
