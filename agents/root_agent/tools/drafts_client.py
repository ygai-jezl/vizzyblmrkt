"""Pure, ADK-free client logic for the get_drafts tool.

Mirrors settings_history_client.py: the request/response logic lives here (no ADK import) so it
stays unit-testable without ADK; the only side effect, the HTTP call, is isolated in `_request` so
tests can monkeypatch it. Auth reuses the signed canvas capability token (`ctxToken` in session
state); the app takes the brand from that token, never from here.

The answer is the agent record: what Vizzy, research and the autopilot drafted for the brand and
what became of each (waiting, kept, kept after a person's edits, dismissed), per kind over the last
30 days (90 at most), or one kind's newest ten. Read only: a person decides each draft in the app.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

PATH = "/api/agent/drafts"
_TIMEOUT_SECONDS = 30
KINDS = (
    "launch_journey",
    "lifecycle_journey",
    "invite_wave",
    "content_plan",
    "email_style",
    "image_style",
    "journey_style",
    "brand_map",
    "brand_note",
    "brand_map_research",
    "product_map",
    "autopilot",
)
MAX_DAYS = 90

_OFF = "The record of my drafts isn't switched on in this environment yet, so I can't say what happened to them."
_NO_LINK = "I can't reach the app from this chat yet. Please send that again."

_ERRORS = {
    "agent_record_disabled": _OFF,
    "admins_only": "Only an admin can read what happened to the styles and notes I suggested.",
    "invalid_input": "I asked for that the wrong way. Please ask again in other words.",
    "rate_limited": "I've read a lot just now. Please try again in a minute.",
    "unauthorized": "My session to the app expired. Please send your message again.",
    "canvas_auth_unconfigured": "Reading my drafts from chat isn't set up in this environment yet.",
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
    return {"status": "error", "code": code, "message": _ERRORS.get(code, "I couldn't read my drafts just now. Please try again.")}


def query_string(kind: str = "", days: int = 0) -> str:
    """The query the app reads: only the parts given, never a brand."""
    params = {}
    if kind and kind.strip() in KINDS:
        params["kind"] = kind.strip()
    if isinstance(days, int) and not isinstance(days, bool) and days > 0:
        params["days"] = str(min(days, MAX_DAYS))
    return f"?{urllib.parse.urlencode(params)}" if params else ""


def get_drafts(state: "dict | None", kind: str = "", days: int = 0) -> dict:
    """What became of the drafts Vizzy, research and the autopilot made. Never raises."""
    token = (state or {}).get("ctxToken")
    base = os.environ.get("CANVAS_CALLBACK_URL", "").rstrip("/")
    if not token or not base:
        return {"status": "error", "code": "not_connected", "message": _NO_LINK}
    status_code, body_text = _request("GET", f"{base}{PATH}{query_string(kind, days)}", token)
    body = _json(body_text)
    if 200 <= status_code < 300:
        return {"status": "success", **body}
    return error_result(status_code, body)
