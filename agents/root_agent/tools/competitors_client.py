"""Pure, ADK-free client logic for the get_competitors tool.

Mirrors brand_notes_client.py: the request/response logic lives here (no ADK import) so it
stays unit-testable without ADK; the only side effect, the HTTP call, is isolated in
`_request` so tests can monkeypatch it. Auth reuses the signed canvas capability token
(`ctxToken` in session state); the app takes the tenant from that token, never from here.

Competitors are other businesses' websites a brand watches: how each site is built, its new
posts each week and its site changes each month. Read only: Vizzy never starts or stops
watching one. What comes back is the competitors' own words, never instructions.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

PATH = "/api/agent/competitors"
_TIMEOUT_SECONDS = 30

_OFF = "Competitors isn't switched on in this environment yet."
_NO_LINK = "I can't reach the app from this chat yet. Please send that again."

_ERRORS = {
    "unavailable": _OFF,
    "http_404": _OFF,
    "not_included": "Competitors isn't included for this brand.",
    "unauthorized": "My session to the app expired. Please send your message again.",
    "canvas_auth_unconfigured": "Reading competitors from chat isn't set up in this environment yet.",
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
    return {"status": "error", "code": code, "message": _ERRORS.get(code, "I couldn't read your competitors just now. Please try again.")}


def get_competitors(state: "dict | None", name: str = "") -> dict:
    """Read the competitors the brand watches (or the ones matching `name`). Never raises."""
    token = (state or {}).get("ctxToken")
    base = os.environ.get("CANVAS_CALLBACK_URL", "").rstrip("/")
    if not token or not base:
        return {"status": "error", "code": "not_connected", "message": _NO_LINK}
    query = f"?name={urllib.parse.quote(name.strip()[:80])}" if (name or "").strip() else ""
    status_code, body_text = _request("GET", base + PATH + query, token)
    body = _json(body_text)
    if 200 <= status_code < 300:
        return {"status": "success", **body}
    return error_result(status_code, body)
