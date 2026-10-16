"""Pure, ADK-free client logic for the get_setup_status and read_help_page tools.

Mirrors insights_client.py: the HTTP GET is isolated in `_get` so tests can
monkeypatch it, and auth reuses the signed canvas capability token (`ctxToken` in
session state); the /api/agent/setup and /api/agent/help routes take the tenant
from that token, never from here.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

SETUP_PATH = "/api/agent/setup"
HELP_PATH = "/api/agent/help"
_TIMEOUT_SECONDS = 30
_PAGE = re.compile(r"^[a-z0-9-]{1,60}$")

_ERRORS = {
    "unavailable": "The setup guide isn't switched on in this environment yet.",
    "canvas_auth_unconfigured": "The setup guide isn't available from chat in this environment yet.",
    "unauthorized": "My session to the app expired. Please send your message again.",
    "rate_limited": "I've checked your setup several times just now. Please try again in a few minutes.",
    "not_found": "There's no help page by that name.",
}


def _get(url: str, token: str) -> "tuple[int, str]":
    """GET an endpoint. Isolated so tests can monkeypatch it."""
    req = urllib.request.Request(url, method="GET", headers={"X-Canvas-Context": token})
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_SECONDS) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", errors="replace")
    except urllib.error.URLError as exc:
        return 0, json.dumps({"error": "network_error", "detail": str(exc.reason)})


def parse_response(status_code: int, body_text: str) -> dict:
    """Normalize an endpoint response into a tool result."""
    try:
        body = json.loads(body_text) if body_text else {}
    except (json.JSONDecodeError, ValueError):
        body = {}
    if not isinstance(body, dict):
        body = {}
    if 200 <= status_code < 300:
        return {"status": "success", **body}
    code = body.get("error") or f"http_{status_code}"
    out = {
        "status": "error",
        "code": code,
        "message": _ERRORS.get(code, "I couldn't reach the setup guide just now. Please try again."),
    }
    if isinstance(body.get("pages"), list):
        out["pages"] = body["pages"]
    return out


def _base_and_token(state: "dict | None") -> "tuple[str, str] | dict":
    token = (state or {}).get("ctxToken")
    if not token:
        return {"status": "unavailable", "message": "The setup guide isn't available in this session yet."}
    base = os.environ.get("CANVAS_CALLBACK_URL", "").rstrip("/")
    if not base:
        return {"status": "unavailable", "message": "The setup guide isn't configured (no callback URL)."}
    return base, token


def get_status(state: "dict | None") -> dict:
    """The brand's setup steps, done and to do. Never raises."""
    found = _base_and_token(state)
    if isinstance(found, dict):
        return found
    base, token = found
    return parse_response(*_get(base + SETUP_PATH, token))


def get_help_page(state: "dict | None", page: str) -> dict:
    """One help page as Markdown. Never raises."""
    page = (page or "").strip().lower()
    if not _PAGE.match(page):
        return {"status": "error", "code": "not_found", "message": _ERRORS["not_found"]}
    found = _base_and_token(state)
    if isinstance(found, dict):
        return found
    base, token = found
    return parse_response(*_get(f"{base}{HELP_PATH}?page={urllib.parse.quote(page)}", token))
