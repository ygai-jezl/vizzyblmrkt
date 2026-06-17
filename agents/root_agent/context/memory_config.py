"""Memory Bank configuration / helpers.

Vizzybl is multi-tenant — a single operator may manage multiple tenants. Memory
Bank scopes long-term memory by `user_id`, so we use a composite key
`{tenantId}_{userId}` to prevent cross-tenant memory bleed. The Next.js proxy
sets exactly this composite as `user_id` on every streamQuery call.

When deployed to Agent Runtime as an AdkApp, Memory Bank is provisioned and
attached by default — no explicit VertexAiMemoryBankService wiring is required
at runtime. `get_memory_service()` exists for local-runner / explicit-wiring
scenarios and degrades to None if the SDK isn't available.

See: https://docs.cloud.google.com/gemini-enterprise-agent-platform/scale/memory-bank
"""

from __future__ import annotations

import os
from typing import Any, Optional

from ..agent_logging.logger import logger

MEMORY_TTL_DAYS = 90


def composite_user_id(tenant_id: str, user_id: str) -> str:
    """Composite Memory Bank scope key — prevents cross-tenant memory bleed."""
    return f"{tenant_id}_{user_id}"


def get_memory_service() -> Optional[Any]:
    """Initialize the Vertex AI Memory Bank service for a local Runner.

    Returns None if the SDK isn't available so the agent still works without it.
    Not needed on Agent Runtime (Memory Bank is the default there).
    """
    try:
        from google.adk.memory import VertexAiMemoryBankService  # type: ignore
    except ImportError:
        logger.warn("VertexAiMemoryBankService not available — memory disabled")
        return None

    project = os.environ.get("GOOGLE_CLOUD_PROJECT")
    location = os.environ.get("ROOT_AGENT_LOCATION") or os.environ.get(
        "GOOGLE_CLOUD_LOCATION", "us-central1"
    )
    try:
        service = VertexAiMemoryBankService(project=project, location=location)
        logger.info("Memory Bank initialized", project=project, location=location)
        return service
    except Exception as e:  # pragma: no cover - defensive
        logger.error("Memory Bank init failed", error=str(e))
        return None
