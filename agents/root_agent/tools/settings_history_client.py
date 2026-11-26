"""Pure, ADK-free client logic for the get_settings_history tool.

Mirrors content_strategy_client.py: the request/response logic lives here (no ADK import) so it
stays unit-testable without ADK; the only side effect, the HTTP call, is isolated in `_request` so
tests can monkeypatch it. Auth reuses the signed canvas capability token (`ctxToken` in session
state); the app takes the brand from that token, never from here.

The answer is the brand's Settings › History: every change to its fields, journeys, product
catalogs, shared connections and team views, newest first, with who made it (display names only, never an
address), or one version whole. Read only: restoring is a person's, in the app.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

PATH = "/api/agent/settings-history"
_TIMEOUT_SECONDS = 30
_KINDS = ("fields", "journeys", "catalogs", "connections", "views")

_OFF = "Settings history isn't switched on in this environment yet."
_NO_LINK = "I can't reach the app from this chat yet. Please send that again."

# `not_found` is the app's answer when settings history itself is off. Reading one version whole
# has its own answers: a kind that isn't switched on, an archived journey or a revoked product (read
# only, listed but never opened whole), and a version that isn't there.
_ERRORS = {
    "not_found": _OFF,
    "http_404": _OFF,
    "kind_not_shown": "That kind of setting isn't switched on here, so I can't open its versions.",
    "journey_archived": "That journey is archived, so its versions are read only: I can list its changes but not open a version whole.",
    "connection_revoked": "That product's connection is revoked, so its catalog versions are read only: I can list their changes but not open one whole.",
    "version_not_found": "That version isn't there. Ask for the history again to see which versions there are.",
    "invalid_input": "I asked for that history the wrong way. Please ask again in other words.",
    "invalid_cursor": "That page of the history has expired. Ask again from the start.",
    "invalid_subject": "I asked for that history the wrong way. Please ask again in other words.",
    "rate_limited": "I've read a lot just now. Please try again in a minute.",
    "unauthorized": "My session to the app expired. Please send your message again.",
    "canvas_auth_unconfigured": "Reading settings history from chat isn't set up in this environment yet.",
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
    return {"status": "error", "code": code, "message": _ERRORS.get(code, "I couldn't read the history just now. Please try again.")}


def query_string(kind: str = "", subject: str = "", version: int = 0, cursor: str = "") -> str:
    """The query the app reads: only the parts given, never a brand."""
    params = {}
    if kind and kind.strip() in _KINDS:
        params["kind"] = kind.strip()
    if subject and subject.strip():
        params["subject"] = subject.strip()[:80]
    if version and isinstance(version, int) and version > 0 and params.get("subject"):
        params["rev"] = str(version)
    if cursor and cursor.strip():
        params["cursor"] = cursor.strip()[:4000]
    return f"?{urllib.parse.urlencode(params)}" if params else ""


def get_settings_history(state: "dict | None", kind: str = "", subject: str = "", version: int = 0, cursor: str = "") -> dict:
    """The brand's settings history, or one version whole. Never raises."""
    token = (state or {}).get("ctxToken")
    base = os.environ.get("CANVAS_CALLBACK_URL", "").rstrip("/")
    if not token or not base:
        return {"status": "error", "code": "not_connected", "message": _NO_LINK}
    status_code, body_text = _request("GET", f"{base}{PATH}{query_string(kind, subject, version, cursor)}", token)
    body = _json(body_text)
    if 200 <= status_code < 300:
        return {"status": "success", **body}
    return error_result(status_code, body)
