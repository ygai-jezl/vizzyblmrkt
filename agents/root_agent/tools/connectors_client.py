"""Pure, ADK-free client logic for the list_connections and read_connected_live tools.

Mirrors results_client.py: the request/response logic lives here (no ADK import) so it stays
unit-testable without ADK; the only side effect, the HTTP call, is isolated in `_request` so tests
can monkeypatch it. Auth reuses the signed canvas capability token (`ctxToken` in session state);
the app takes the brand from that token, never from here.

Reads only. Vizzy sees a brand's connected data (Cloudflare, Google Search Console, Google
Analytics) only where an admin let Vizzy read it, and reads it for a member only when members may
read it too. Every number in an answer comes with its meaning in `meanings`.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import re
import urllib.error
import urllib.request

LIST_PATH = "/api/agent/connectors"
LIVE_PATH = "/api/agent/connectors/live"
_TIMEOUT_SECONDS = 30

BY = ("day", "page", "topic")
MAX_ROWS = 100
MAX_DAYS = 93
_CONNECTION = re.compile(r"^dcn_[a-z2-7]{20}$")
_STREAM = re.compile(r"^[a-z][a-z0-9_]{1,39}$")

_OFF = "Reading connected data isn't switched on in this environment yet."
_NO_LINK = "I can't reach the app from this chat yet. Please send that again."
_NO_GRANT = "I'm not allowed to read that connection. An admin can let Vizzy read it on the connection in Settings › Connections › Connected."

_ERRORS = {
    "unavailable": _OFF,
    "http_404": _OFF,
    "not_found": "I couldn't find that connection. Ask me what's connected to see the ones I can read.",
    "connector_off": "That connector is turned off in this copy of YouGrow.",
    "no_agent_grant": _NO_GRANT,
    "no_read_grant": "Members aren't allowed to read that connection, so I can't read it for you. An admin can allow members to read it.",
    "rate_limited": "I've read a lot of connected data just now. Please try again in a minute.",
    "busy": "That connection was asked a lot in the last few minutes. Please try again shortly.",
    "unauthorized": "My session to the app expired. Please send your message again.",
    "canvas_auth_unconfigured": "Reading connected data from chat isn't set up in this environment yet.",
    "invalid_input": "I couldn't read that. Check the connection, the stream and the dates.",
    "unknown_stream": "That connection doesn't give that stream. Ask me what's connected to see its streams.",
    "by_not_allowed": "That connection can't be grouped that way. Ask me what's connected to see how it can be.",
    "bad_dates": "Those dates don't work: the start must be on or before the end, and neither in the future.",
    "too_many_days": "I can read at most 93 days at a time. Ask for a shorter period.",
    "connection_required": "Tell me which connection to read. Ask me what's connected first if you're not sure.",
    "network_error": "I couldn't reach the app just now. Please try again.",
}


def _request(method: str, url: str, token: str, payload: "dict | None" = None, timeout: int = _TIMEOUT_SECONDS) -> "tuple[int, str]":
    """One HTTP call to the app. Isolated so tests can monkeypatch it."""
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"X-Canvas-Context": token}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
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
    """The app's refusal in plain words. The app's own words win where it sent some."""
    code = body.get("error") or f"http_{status_code}"
    message = _ERRORS.get(code) or body.get("message") or "I couldn't read that connection just now. Please try again."
    return {"status": "error", "code": code, "message": message}


def _call(state: "dict | None", method: str, path: str, payload: "dict | None" = None) -> dict:
    token = (state or {}).get("ctxToken")
    base = os.environ.get("CANVAS_CALLBACK_URL", "").rstrip("/")
    if not token or not base:
        return {"status": "error", "code": "not_connected", "message": _NO_LINK}
    status_code, body_text = _request(method, base + path, token, payload)
    body = _json(body_text)
    if 200 <= status_code < 300:
        return {"status": "success", **body}
    return error_result(status_code, body)


def _day(value: str) -> "str | None":
    text = (value or "").strip()
    try:
        return _dt.date.fromisoformat(text).isoformat() if len(text) == 10 else None
    except ValueError:
        return None


def list_connections(state: "dict | None") -> dict:
    """The brand's connections Vizzy may read, their health and what each gives. Never raises."""
    return _call(state, "GET", LIST_PATH)


def read_connected_live(
    state: "dict | None",
    connection_id: str = "",
    stream: str = "",
    from_date: str = "",
    to_date: str = "",
    by: str = "day",
    limit: int = 50,
) -> dict:
    """One capped live read of a connection, every number with its meaning. Never raises."""
    cid = (connection_id or "").strip()
    if not _CONNECTION.match(cid):
        return {"status": "error", "code": "connection_required", "message": _ERRORS["connection_required"]}
    name = (stream or "").strip()
    start, end = _day(from_date), _day(to_date)
    if not _STREAM.match(name) or not start or not end:
        return {"status": "error", "code": "invalid_input", "message": _ERRORS["invalid_input"]}
    if start > end:
        return {"status": "error", "code": "bad_dates", "message": _ERRORS["bad_dates"]}
    if (_dt.date.fromisoformat(end) - _dt.date.fromisoformat(start)).days + 1 > MAX_DAYS:
        return {"status": "error", "code": "too_many_days", "message": _ERRORS["too_many_days"]}
    try:
        rows = max(1, min(int(limit), MAX_ROWS))
    except (TypeError, ValueError):
        rows = 50
    group = by if by in BY else "day"
    return _call(state, "POST", LIVE_PATH, {"connectionId": cid, "stream": name, "from": start, "to": end, "by": group, "limit": rows})
