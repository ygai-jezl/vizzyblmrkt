"""Pure, ADK-free client logic for the get_email_results and get_post_results tools.

Mirrors search_client.py: the request/response logic lives here (no ADK import) so it stays
unit-testable without ADK; the only side effect, the HTTP call, is isolated in `_request` so
tests can monkeypatch it. Auth reuses the signed canvas capability token (`ctxToken` in session
state); the app takes the brand from that token, never from here.

Both tools return aggregates only (never a person) and a `meanings` map that explains every
number in the answer: its definition, what one count is of, and what to bear in mind.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

EMAIL_PATH = "/api/agent/results/email"
POSTS_PATH = "/api/agent/results/posts"
_TIMEOUT_SECONDS = 30

SCOPES = ("overview", "launch", "journey")
CHANNELS = ("linkedin", "x")
_ID = re.compile(r"^[A-Za-z0-9_:.-]{1,120}$")

_OFF = "Reading results isn't switched on in this environment yet."
_NO_LINK = "I can't reach the app from this chat yet. Please send that again."

_ERRORS = {
    "unavailable": _OFF,
    "http_404": _OFF,
    "not_found": "I couldn't find that waitlist or journey.",
    "id_required": "Tell me which waitlist or journey you mean.",
    "rate_limited": "I've read a lot of numbers just now. Please try again in a minute.",
    "unauthorized": "My session to the app expired. Please send your message again.",
    "canvas_auth_unconfigured": "Reading results from chat isn't set up in this environment yet.",
    "invalid_input": "I couldn't read results for that. Check the waitlist, journey or period.",
    "network_error": "I couldn't reach the app just now. Please try again.",
}


def _request(method: str, url: str, token: str, timeout: int = _TIMEOUT_SECONDS) -> "tuple[int, str]":
    """One HTTP call to the app. Isolated so tests can monkeypatch it."""
    req = urllib.request.Request(url, method=method, headers={"X-Canvas-Context": token})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", errors="replace")
    except urllib.error.URLError as exc:
        return 0, json.dumps({"error": "network_error", "detail": str(exc.reason)})


def _json(body_text: str) -> dict:
    try:
        body = json.loads(body_text) if body_text else {}
    except (json.JSONDecodeError, ValueError):
        body = {}
    return body if isinstance(body, dict) else {}


def error_result(status_code: int, body: dict) -> dict:
    code = body.get("error") or f"http_{status_code}"
    return {"status": "error", "code": code, "message": _ERRORS.get(code, "I couldn't read those results just now. Please try again.")}


def _call(state: "dict | None", path: str, params: dict) -> dict:
    token = (state or {}).get("ctxToken")
    base = os.environ.get("CANVAS_CALLBACK_URL", "").rstrip("/")
    if not token or not base:
        return {"status": "error", "code": "not_connected", "message": _NO_LINK}
    query = urllib.parse.urlencode({k: v for k, v in params.items() if v not in (None, "")})
    status_code, body_text = _request("GET", base + path + (f"?{query}" if query else ""), token)
    body = _json(body_text)
    if 200 <= status_code < 300:
        return {"status": "success", **body}
    return error_result(status_code, body)


def get_email_results(state: "dict | None", scope: str = "overview", id: str = "") -> dict:
    """How the brand's emails did: overall, for one launch (`id` = launch id) or one journey. Never raises."""
    scope = scope if scope in SCOPES else "overview"
    ident = (id or "").strip()
    if scope != "overview" and not _ID.match(ident):
        return {"status": "error", "code": "id_required", "message": _ERRORS["id_required"]}
    return _call(state, EMAIL_PATH, {"scope": scope, "id": ident if scope != "overview" else None})


def get_post_results(state: "dict | None", channel: str = "", days: int = 30, post: str = "") -> dict:
    """How the brand's LinkedIn and X posts did over the last `days` (1 to 365), or one post. Never raises."""
    try:
        d = max(1, min(int(days), 365))
    except (TypeError, ValueError):
        d = 30
    ch = channel if channel in CHANNELS else None
    return _call(state, POSTS_PATH, {"channel": ch, "days": d, "post": (post or "").strip()[:200] or None})
