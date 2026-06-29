"""Pure, ADK-free client logic for the retrieve_knowledge tool.

Mirrors sub_agents/campaign_ops/tools/canvas_client.py: the request/response/
orchestration logic lives here (no ADK import) so it stays unit-testable without
ADK installed; the only side effect — the HTTP POST — is isolated in
`_post_knowledge` so tests can monkeypatch it. Auth reuses the SAME signed canvas
capability token (`ctxToken` in session state) that the canvas tool uses — the
/api/agent/knowledge route verifies it and reconstructs the tenant scope from the
token, never from the body.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

KNOWLEDGE_PATH = "/api/agent/knowledge"
_TIMEOUT_SECONDS = 30


def build_request_payload(
    campaign_id: str, query: str, limit: "int | None" = None, code: bool = False
) -> dict:
    """Shape the knowledge-endpoint request body."""
    body: dict = {"campaignId": campaign_id, "query": query}
    if limit:
        body["limit"] = limit
    if code:
        body["code"] = True
    return body


def parse_knowledge_response(status_code: int, body_text: str) -> dict:
    """Normalize the endpoint response into a tool-result dict to relay/ground on."""
    try:
        body = json.loads(body_text) if body_text else {}
    except (json.JSONDecodeError, ValueError):
        body = {}
    if not isinstance(body, dict):
        body = {}

    if 200 <= status_code < 300:
        context = body.get("context") or ""
        chunks = body.get("chunks") or []
        if context:
            return {"status": "ok", "context": context, "count": len(chunks)}
        return {
            "status": "empty",
            "context": "",
            "message": "No relevant knowledge has been ingested for this launch yet.",
        }
    code = body.get("error", f"http_{status_code}")
    if code == "canvas_auth_unconfigured":
        msg = "Knowledge retrieval isn't enabled in this environment yet."
    elif code == "unauthorized":
        msg = "This session can't access that launch's knowledge."
    else:
        msg = "I couldn't search the knowledge base just now."
    return {"status": "error", "context": "", "code": code, "message": msg}


def _post_knowledge(url: str, payload: dict, token: str) -> "tuple[int, str]":
    """POST to the knowledge endpoint. Isolated so tests can monkeypatch it."""
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Canvas-Context": token,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_SECONDS) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", errors="replace")
    except urllib.error.URLError as exc:
        return 0, json.dumps({"error": "network_error", "detail": str(exc.reason)})


def retrieve_knowledge_via_api(
    state: dict,
    campaign_id: str,
    query: str,
    limit: "int | None" = None,
    code: bool = False,
) -> dict:
    """Read the capability token + active campaign from session state and POST the
    query to the knowledge endpoint. Returns a dict with `status` and, when found,
    a `context` string to ground on. Degrades softly (never raises) so a turn can
    proceed ungrounded."""
    token = (state or {}).get("ctxToken")
    resolved_campaign = campaign_id or (state or {}).get("campaignId")

    if not token:
        return {
            "status": "unavailable",
            "context": "",
            "message": "Knowledge retrieval isn't available in this session yet.",
        }
    if not resolved_campaign:
        return {
            "status": "needs_campaign",
            "context": "",
            "message": "Which launch's knowledge should I search?",
        }
    if not query or not query.strip():
        return {
            "status": "error",
            "context": "",
            "message": "Give me a topic or question to search for.",
        }

    base = os.environ.get("CANVAS_CALLBACK_URL", "").rstrip("/")
    if not base:
        return {
            "status": "unavailable",
            "context": "",
            "message": "Knowledge retrieval isn't configured (no callback URL).",
        }

    payload = build_request_payload(resolved_campaign, query, limit, code)
    status_code, body_text = _post_knowledge(base + KNOWLEDGE_PATH, payload, token)
    return parse_knowledge_response(status_code, body_text)
