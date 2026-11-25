"""Before-model callback: what the brand told Vizzy, appended to every model call's instruction.

The chat proxy sends the brand profile's rev (`profileRev`, digits) in the `[ctx:]` envelope while
ONBOARDING_ENABLED is on; `apply_context_envelope` has written it into state by the time this
runs (it goes third: envelope, mode, then this). ADK builds the instruction before callbacks run,
so the block is appended here with `llm_request.append_instructions`, in the same call, with no lag.

- No rev (the switch is off, or an older app): nothing is added, so the instruction is as it was.
- A rev ("" with no profile yet): how to use what the brand told Vizzy (`PROFILE_INSTRUCTION`,
  read back, suggest, no chat onboarding) is appended, then the block when there is one.
- A cached block for this brand, person and rev (context/business_profile.py, in process only) is
  appended as it is.
- Otherwise the short chat view is fetched once (5 second timeout) and cached. A fetch that fails
  is not tried again in the same turn (`profileTried` = rev and trace id in state).
- It never raises and never blocks the chat: any failure means no block. Nothing the founder said
  is logged or written to session state.

ADK types stay under TYPE_CHECKING, so this module imports without ADK.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any, Optional

from ..agent_logging.logger import logger
from ..context.business_profile import PROFILE_INSTRUCTION, cache_get, cache_put, format_business_profile_block
from ..tools import business_profile_client as client

if TYPE_CHECKING:
    from google.adk.agents.callback_context import CallbackContext
    from google.adk.models.llm_request import LlmRequest
    from google.adk.models.llm_response import LlmResponse

_TRIED_KEY = "profileTried"
#: A little over the fetch's own timeout, so a stuck thread can't hold the chat.
_WAIT_SECONDS = client.CHAT_READ_TIMEOUT_SECONDS + 1


def _sent_rev(state: Any) -> "Optional[str]":
    """The envelope's rev: digits, or "" (no profile yet); None when the app sent none (switch off)."""
    rev = state.get("profileRev")
    if not isinstance(rev, str) or (rev and not rev.isdigit()):
        return None
    return rev


async def _block_for(state: Any) -> str:
    rev = _sent_rev(state)
    if not rev:
        return ""
    tenant_id, user_id = state.get("tenantId"), state.get("userId")
    cached = cache_get(tenant_id, user_id, rev)
    if cached is not None:
        return cached
    tried = f"{rev}:{state.get('traceId') or ''}"
    if state.get(_TRIED_KEY) == tried:
        return ""
    state[_TRIED_KEY] = tried
    view = await asyncio.wait_for(
        asyncio.to_thread(client.fetch_chat_profile, {"ctxToken": state.get("ctxToken")}),
        timeout=_WAIT_SECONDS,
    )
    if view is None:
        logger.warn("Business profile unavailable", tenant_id=str(tenant_id or "unknown"), rev=rev)
        return ""
    block = format_business_profile_block(view)
    cache_put(tenant_id, user_id, rev, block)
    return block


async def apply_business_profile(
    callback_context: "CallbackContext",
    llm_request: "LlmRequest",
) -> "Optional[LlmResponse]":
    """Append how to use the brand's profile, and its block when there is one, to this model call. Never raises."""
    try:
        state = getattr(callback_context, "state", None)
        if state is None or _sent_rev(state) is None:
            return None
        try:
            block = await _block_for(state)
        except Exception as e:  # noqa: BLE001 - fails soft: the chat goes on without the block
            logger.warn("Business profile not read", error=type(e).__name__)
            block = ""
        llm_request.append_instructions([PROFILE_INSTRUCTION, block] if block else [PROFILE_INSTRUCTION])
    except Exception as e:  # noqa: BLE001 - fails soft: the chat goes on without either
        logger.warn("Business profile not added", error=type(e).__name__)
    return None
