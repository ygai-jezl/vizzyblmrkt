"""Workaround: replace the numeric project NUMBER with the literal project ID.

Background (google/adk-python #5753 + Agent Runtime behaviour):
Inside the Agent Runtime container, the platform sets the *reserved* env var
`GOOGLE_CLOUD_PROJECT` to the project **number** (e.g. "123456789012").
`google.auth.default()` then returns that number, which breaks the Agent
Identity / Regional Access Boundary credential lookup: the engine logs
`Regional Access Boundary HTTP request failed ... 401 UNAUTHENTICATED` and the
serving endpoint returns a gateway 404 (never routable), even though the
container is healthy.

`GOOGLE_CLOUD_PROJECT` is reserved, so we can't override it at deploy time.
deploy.sh sets `AGENT_PROJECT_ID` (the literal project id) in the engine's env
instead, and we re-set `GOOGLE_CLOUD_PROJECT` to it at IMPORT time, before
google-auth resolves credentials for the identity/RAB lookup. Imported first by
both `__init__.py` and `agent.py` so the fix is in place however ADK loads the
agent.

Remove once the platform bug is fixed (then the reserved var is correct, or
`AGENT_IDENTITY` works directly). Tracked at google/adk-python#5753.
"""

from __future__ import annotations

import os


def _apply() -> None:
    pid = os.environ.get("GOOGLE_CLOUD_PROJECT", "")
    if not pid.isdigit():
        return  # already a literal ID (or unset): nothing to do
    project_id = os.environ.get("AGENT_PROJECT_ID", "").strip()
    if project_id:
        os.environ["GOOGLE_CLOUD_PROJECT"] = project_id


_apply()
