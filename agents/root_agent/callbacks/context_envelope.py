"""Context envelope callback — hydrate session state from a leading message prefix.

Vertex AI's streamQuery API doesn't accept arbitrary `metadata` at the request
root (it rejects unknown fields with HTTP 400). To pass tenantId / userId /
region / traceId from the Next.js proxy to this Python agent, we embed a JSON
envelope as a leading prefix on the user message:

    [ctx:{"tenantId":"...","userId":"...","region":"...","traceId":"..."}] {original message}

This callback:
  1. Parses the envelope from the latest user-role message
  2. Writes each key into `callback_context.state` so tools/instructions can read it
  3. Strips the envelope from the message in place — Gemini sees only the real text

Layered with `apply_chat_mode` (which strips a `[mode:X]` prefix); both run in
the `before_model_callback` chain BEFORE Gemini, so the model never sees either
marker.

Ported verbatim from the sibling supervisor agent. ADK types are imported only
under TYPE_CHECKING (annotations are strings via `from __future__`), so the pure
`_extract_envelope` helper stays unit-testable without ADK installed.
"""

from __future__ import annotations

import json
import re
from typing import TYPE_CHECKING, Optional, Tuple

from ..agent_logging.logger import logger

if TYPE_CHECKING:
    from google.adk.agents.callback_context import CallbackContext
    from google.adk.models.llm_request import LlmRequest
    from google.adk.models.llm_response import LlmResponse

# Match `[ctx:{...}]` with a single JSON object. Non-greedy so `}]` ends at the
# first close-brace + close-bracket pair after the opening `[ctx:`.
_ENVELOPE_RE = re.compile(r"^\s*\[ctx:(\{.*?\})\]\s*", re.DOTALL)


def _extract_envelope(text: str) -> Tuple[str, Optional[dict]]:
    m = _ENVELOPE_RE.match(text)
    if not m:
        return text, None
    try:
        ctx_data = json.loads(m.group(1))
    except json.JSONDecodeError:
        return text, None
    if not isinstance(ctx_data, dict):
        return text, None
    cleaned = _ENVELOPE_RE.sub("", text, count=1)
    return cleaned, ctx_data


async def apply_context_envelope(
    callback_context: "CallbackContext",
    llm_request: "LlmRequest",
) -> "Optional[LlmResponse]":
    """Hydrate session state from a `[ctx:{...}]` prefix on the latest user message."""
    contents = getattr(llm_request, "contents", None) or []
    if not contents:
        return None

    for content in reversed(contents):
        if getattr(content, "role", None) != "user":
            continue
        parts = getattr(content, "parts", None) or []
        for part in parts:
            text = getattr(part, "text", None)
            if not text:
                continue
            cleaned, ctx_data = _extract_envelope(text)
            if ctx_data:
                state = getattr(callback_context, "state", None)
                if state is not None:
                    for key, value in ctx_data.items():
                        try:
                            state[key] = value
                        except Exception as e:  # pragma: no cover - defensive
                            logger.warn("Failed to write state key", key=key, error=str(e))
                part.text = cleaned  # mutate in place
                logger.info(
                    "Context envelope applied",
                    tenant_id=ctx_data.get("tenantId", "unknown"),
                    trace_id=ctx_data.get("traceId", ""),
                    keys=list(ctx_data.keys()),
                )
            break
        break

    return None
