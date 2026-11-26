"""Pure, ADK-free client logic for the get_next_action tool.

Mirrors next_up_client.py: the request/response logic lives here (no ADK import) so it stays
unit-testable without ADK; the only side effect, the HTTP call, is isolated in `_request` so tests
can monkeypatch it. Auth reuses the signed canvas capability token (`ctxToken` in session state);
the app takes the brand and the person's role from that token, never from here.

The answer is Home's Your next action (NEXT_ACTION_CARD_ENABLED): the card on Home now, each step
with what its button does and what became of it, and the newest outcomes of earlier steps (done,
answered, dismissed with the person's reason, or ignored). Read only, and for admins. The card's
lines are written from the founder's words, and a reason is theirs: nothing here logs them.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

PATH = "/api/agent/next-action"
_TIMEOUT_SECONDS = 30

_OFF = "Your next action isn't switched on in this environment yet."
_NO_LINK = "I can't reach the app from this chat yet. Please send that again."

_ERRORS = {
    "unavailable": _OFF,
    "http_404": _OFF,
    "admins_only": "Only an admin can read Your next action: it's written from what the admins told me about the business.",
    "unauthorized": "My session to the app expired. Please send your message again.",
    "canvas_auth_unconfigured": "Reading Your next action from chat isn't set up in this environment yet.",
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
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return 0, json.dumps({"error": "network_error", "detail": type(exc).__name__})


def _json(body_text: str) -> dict:
    try:
        body = json.loads(body_text) if body_text else {}
    except (json.JSONDecodeError, ValueError):
        body = {}
    return body if isinstance(body, dict) else {}


def error_result(status_code: int, body: dict) -> dict:
    code = body.get("error") or f"http_{status_code}"
    return {"status": "error", "code": code, "message": _ERRORS.get(code, "I couldn't read Your next action just now. Please try again.")}


def get_next_action(state: "dict | None") -> dict:
    """Home's Your next action and the newest outcomes. Never raises."""
    token = (state or {}).get("ctxToken")
    base = os.environ.get("CANVAS_CALLBACK_URL", "").rstrip("/")
    if not token or not base:
        return {"status": "error", "code": "not_connected", "message": _NO_LINK}
    status_code, body_text = _request("GET", f"{base}{PATH}", token)
    body = _json(body_text)
    if 200 <= status_code < 300:
        return {"status": "success", **body}
    return error_result(status_code, body)
