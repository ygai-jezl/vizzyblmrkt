"""Pure, ADK-free client logic for the get_audience_counts tool.

Mirrors insights_client.py: the request/response logic lives here (no ADK import)
so it stays unit-testable without ADK; the only side effect, the HTTP GET, is
isolated in `_get` so tests can monkeypatch it. Auth reuses the signed canvas
capability token (`ctxToken` in session state); the /api/agent/audience/counts
route takes the tenant from that token, never from here.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

COUNTS_PATH = "/api/agent/audience/counts"
_TIMEOUT_SECONDS = 30

_ERRORS = {
    "unavailable": "The one People list isn't switched on in this environment yet.",
    "canvas_auth_unconfigured": "Audience counts from chat aren't enabled in this environment yet.",
    "unauthorized": "My session to the app expired. Please send your message again.",
    "rate_limited": "I've counted several times just now. Please try again in a few minutes.",
}


def _get(url: str, token: str) -> "tuple[int, str]":
    """GET the counts endpoint. Isolated so tests can monkeypatch it."""
    req = urllib.request.Request(url, method="GET", headers={"X-Canvas-Context": token})
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_SECONDS) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", errors="replace")
    except urllib.error.URLError as exc:
        return 0, json.dumps({"error": "network_error", "detail": str(exc.reason)})


def parse_counts_response(status_code: int, body_text: str) -> dict:
    """Normalize the endpoint response into a tool result to answer from."""
    try:
        body = json.loads(body_text) if body_text else {}
    except (json.JSONDecodeError, ValueError):
        body = {}
    if not isinstance(body, dict):
        body = {}
    if 200 <= status_code < 300:
        return {"status": "success", **body}
    code = body.get("error") or f"http_{status_code}"
    return {
        "status": "error",
        "code": code,
        "message": _ERRORS.get(code, "I couldn't count your audience just now. Please try again."),
    }


def get_counts(state: "dict | None") -> dict:
    """Fetch the audience counts for the session's tenant. Never raises."""
    token = (state or {}).get("ctxToken")
    if not token:
        return {"status": "unavailable", "message": "Audience counts aren't available in this session yet."}
    base = os.environ.get("CANVAS_CALLBACK_URL", "").rstrip("/")
    if not base:
        return {"status": "unavailable", "message": "Audience counts aren't configured (no callback URL)."}
    status_code, body_text = _get(base + COUNTS_PATH, token)
    return parse_counts_response(status_code, body_text)
