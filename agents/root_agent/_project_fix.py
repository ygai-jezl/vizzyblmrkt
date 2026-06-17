"""Workaround: translate the numeric project NUMBER to the literal project ID.

Background (google/adk-python #5753 + Agent Runtime behaviour):
Inside the Agent Runtime container, the platform sets the *reserved* env var
`GOOGLE_CLOUD_PROJECT` to the project **number** (e.g. "647082740268").
`google.auth.default()` then returns that number, which breaks the Agent
Identity / Regional Access Boundary credential lookup — the engine logs
`Regional Access Boundary HTTP request failed … 401 UNAUTHENTICATED` and the
serving endpoint returns a gateway 404 (never routable), even though the
container is healthy.

`GOOGLE_CLOUD_PROJECT` is reserved, so we can't override it at deploy time. We
instead re-set it to the literal project ID at IMPORT time — before google-auth
resolves credentials for the identity/RAB lookup. Imported first by both
`__init__.py` and `agent.py` so the fix is in place however ADK loads the agent.

Remove once the platform bug is fixed (then the reserved var is correct, or
`AGENT_IDENTITY` works directly). Tracked at google/adk-python#5753.
"""

from __future__ import annotations

import os

# Project NUMBER -> literal project ID for this app's GCP projects.
_PROJECT_NUMBER_TO_ID = {
    "647082740268": "vizzybl-marketing-dev",
    "846772303107": "vizzybl-marketing-prod",
}


def _apply() -> None:
    pid = os.environ.get("GOOGLE_CLOUD_PROJECT", "")
    if not pid.isdigit():
        return  # already a literal ID (or unset) — nothing to do
    # Prefer the known map; fall back to an explicit AGENT_PROJECT_ID override.
    mapped = _PROJECT_NUMBER_TO_ID.get(pid) or os.environ.get("AGENT_PROJECT_ID")
    if mapped:
        os.environ["GOOGLE_CLOUD_PROJECT"] = mapped


_apply()
