"""Pure, ADK-free client logic for the get_image_style and suggest_image_style tools.

Mirrors email_style_client.py: the request/response logic lives here (no ADK import) so it
stays unit-testable without ADK; the only side effect, the HTTP call, is isolated in
`_request` so tests can monkeypatch it. Auth reuses the signed canvas capability token
(`ctxToken` in session state); the app takes the tenant and the role from that token, never
from here.

The image style is brand-wide: the look every image Create makes starts from (a default, and
any channel's own). Vizzy only ever saves a SUGGESTION through the canvas endpoint: nothing
changes until an admin saves it on Brand › Image style.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

READ_PATH = "/api/agent/image-style"
CANVAS_PATH = "/api/agent/canvas"
_TIMEOUT_SECONDS = 30
_REASON_MAX = 500  # what the server keeps
_BRIEF_MAX = 500

CHANNELS = ("blogHero", "linkedin", "x", "instagram", "newsletter", "ebook", "launchEmail")

_OFF = "Image styles aren't switched on in this environment yet."
_NO_LINK = "I can't reach the app from this chat yet. Please send that again."

_ERRORS = {
    "unavailable": _OFF,
    "unknown_kind": _OFF,
    "http_404": _OFF,
    "forbidden": (
        "Only an admin can suggest an image style. An admin of this account can ask me, "
        "or change it in Brand › Image style."
    ),
    "unauthorized": "My session to the app expired. Please send your message again.",
    "canvas_auth_unconfigured": "Image styles from chat aren't set up in this environment yet.",
    "rate_limited": "I've suggested several image styles just now. Please try again in a few minutes.",
    "invalid_input": "Some of the style wasn't valid",
    "style_not_built": "That style isn't available yet",
    "tenant_not_found": "I couldn't find this account.",
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
    base = _ERRORS.get(code, "I couldn't do that with the image style just now. Please try again.")
    detail = "; ".join(str(i) for i in issues[:8])
    return {
        "status": "error",
        "code": code,
        "issues": issues[:20],
        "message": f"{base}: {detail}" if detail else base,
    }


def _style_id(value: str) -> str:
    """A style id from the read's `styles`, or its label ("Product noir" → "product_noir")."""
    return "_".join((value or "").strip().lower().replace("-", " ").split())


def build_suggest_payload(default_style: str, reason: str, brief: str, channels: "dict | None" = None) -> dict:
    """The canvas request: the default, any channel's own style, and why."""
    payload: dict = {
        "kind": "image_style",
        "action": "save_draft",
        "brief": (brief or "")[:_BRIEF_MAX],
        "defaultStyleId": _style_id(default_style),
        "reason": (reason or "").strip()[:_REASON_MAX],
    }
    picked = {}
    for channel, style in (channels or {}).items():
        key = next((c for c in CHANNELS if c.lower() == str(channel).strip().lower()), None)
        if key and str(style or "").strip():
            picked[key] = _style_id(str(style))
    if picked:
        payload["channels"] = picked
    return payload


def parse_suggest_response(status_code: int, body_text: str) -> dict:
    """Normalise the canvas endpoint's answer into a tool result (the card rides along)."""
    body = _json(body_text)
    if 200 <= status_code < 300 and body.get("ok"):
        return {
            "status": "success",
            "url": body.get("url"),
            "card": body.get("card"),
            "message": body.get("summary")
            or "Suggested an image style. Nothing changes until an admin reviews and saves it in Brand › Image style.",
        }
    return error_result(status_code, body)


def get_style(state: "dict | None") -> dict:
    """Read the saved image style, any pending suggestion and the styles to pick from. Never raises."""
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    status_code, body_text = _request("GET", base + READ_PATH, token)
    body = _json(body_text)
    if 200 <= status_code < 300:
        return {"status": "success", **body}
    return error_result(status_code, body)


def suggest_style(state: "dict | None", default_style: str, reason: str, brief: str, channels: "dict | None" = None) -> dict:
    """Save an image style SUGGESTION for an admin to review. Never raises."""
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    payload = build_suggest_payload(default_style, reason, brief, channels)
    status_code, body_text = _request("POST", base + CANVAS_PATH, token, payload)
    return parse_suggest_response(status_code, body_text)
