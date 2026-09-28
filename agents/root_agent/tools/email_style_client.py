"""Pure, ADK-free client logic for the get_email_style and suggest_email_style tools.

Mirrors insights_client.py: the request/response logic lives here (no ADK import)
so it stays unit-testable without ADK; the only side effect — the HTTP call — is
isolated in `_request` so tests can monkeypatch it. Auth reuses the signed canvas
capability token (`ctxToken` in session state); the app takes the tenant and the
role from that token, never from here.

The Email style is brand-wide (logo, company name, header and button colours on
every branded email). Vizzy only ever saves a SUGGESTION through the canvas
endpoint: nothing changes until an admin saves it on Brand › Email style.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

READ_PATH = "/api/agent/email-style"
CANVAS_PATH = "/api/agent/canvas"
_TIMEOUT_SECONDS = 30
_BRIEF_MAX = 500  # what the server keeps

_OFF = "Email style isn't switched on in this environment yet."
# Only when this chat has no token or callback URL — never "switched on", since the
# feature may well be on.
_NO_LINK = "I can't reach the app from this chat yet — please send that again."

_ERRORS = {
    # The flag is off, or the app predates the Email style (no kind, no read route).
    "unavailable": _OFF,
    "unknown_kind": _OFF,
    "http_404": _OFF,
    "forbidden": (
        "Only an admin can suggest an email style. An admin of this account can ask me, "
        "or change it in Brand › Email style."
    ),
    "unauthorized": "My session to the app expired — please send your message again.",
    "canvas_auth_unconfigured": "Email style from chat isn't set up in this environment yet.",
    "rate_limited": "I've suggested several email styles just now. Please try again in a few minutes.",
    "invalid_input": "Some of the style wasn't valid",
    "invalid_logo": "That logo can't be used",
    "tenant_not_found": "I couldn't find this account.",
    "logos_unavailable": "I couldn't read your logos just now. Please try again.",
    "network_error": "I couldn't reach the app just now. Please try again.",
}


def _request(method: str, url: str, token: str, payload: "dict | None" = None) -> "tuple[int, str]":
    """One HTTP call to the app. Isolated so tests can monkeypatch it."""
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"X-Canvas-Context": token}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_SECONDS) as resp:
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


def _base_and_token(state: "dict | None") -> "tuple[str, str] | dict":
    token = (state or {}).get("ctxToken")
    base = os.environ.get("CANVAS_CALLBACK_URL", "").rstrip("/")
    if not token or not base:
        return {"status": "error", "code": "not_connected", "message": _NO_LINK}
    return base, token


def error_result(status_code: int, body: dict) -> dict:
    code = body.get("error") or f"http_{status_code}"
    issues = body.get("issues") or []
    base = _ERRORS.get(code, "I couldn't do that with the Email style just now. Please try again.")
    detail = "; ".join(str(i) for i in issues[:8])
    return {
        "status": "error",
        "code": code,
        "issues": issues[:20],
        "message": f"{base}: {detail}" if detail else base,
    }


def build_suggest_payload(
    mode: str,
    brief: str,
    header_color: str = "",
    button_color: str = "",
    logo: str = "",
    company_name: str = "",
    hide_company_name: bool = False,
) -> dict:
    """The canvas request: only the fields the operator asked for, so the rest are kept."""
    payload: dict = {
        "kind": "email_style",
        "action": "save_draft",
        "mode": (mode or "").strip() or "edit",
        "brief": (brief or "")[:_BRIEF_MAX],
    }
    if (header_color or "").strip():
        payload["headerColor"] = header_color.strip()
    if (button_color or "").strip():
        payload["buttonColor"] = button_color.strip()
    if (logo or "").strip():
        payload["logo"] = logo.strip()
    # null hides the name, so the logo shows alone.
    if hide_company_name:
        payload["companyName"] = None
    elif (company_name or "").strip():
        payload["companyName"] = company_name.strip()
    return payload


def parse_suggest_response(status_code: int, body_text: str) -> dict:
    """Normalise the canvas endpoint's answer into a tool result (the card rides along)."""
    body = _json(body_text)
    if 200 <= status_code < 300 and body.get("ok"):
        return {
            "status": "success",
            "url": body.get("url"),
            "warnings": body.get("warnings", []),
            "card": body.get("card"),
            "message": body.get("summary")
            or "Suggested an Email style. Nothing changes until an admin reviews and saves it in Brand › Email style.",
        }
    return error_result(status_code, body)


def get_style(state: "dict | None") -> dict:
    """Read the saved style, any pending suggestion and what the brand kit would pick. Never raises."""
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    status_code, body_text = _request("GET", base + READ_PATH, token)
    body = _json(body_text)
    if 200 <= status_code < 300:
        return {"status": "success", **body}
    return error_result(status_code, body)


def suggest_style(
    state: "dict | None",
    mode: str,
    brief: str,
    header_color: str = "",
    button_color: str = "",
    logo: str = "",
    company_name: str = "",
    hide_company_name: bool = False,
) -> dict:
    """Save an Email style SUGGESTION for an admin to review. Never raises."""
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    payload = build_suggest_payload(mode, brief, header_color, button_color, logo, company_name, hide_company_name)
    status_code, body_text = _request("POST", base + CANVAS_PATH, token, payload)
    return parse_suggest_response(status_code, body_text)
