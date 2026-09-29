"""Pure, ADK-free client logic for the get_journey_email_style and set_journey_email_style tools.

Mirrors email_style_client.py: the request/response logic lives here (no ADK import)
so it stays unit-testable without ADK; the only side effect — the HTTP call — is
isolated in `_request` so tests can monkeypatch it. Auth reuses the signed canvas
capability token (`ctxToken` in session state); the app takes the tenant and the
role from that token, never from here.

A journey's own Email style: one lifecycle journey (a product journey, or a launch's
welcome journey on the new engine) wears the brand's Email style or its own header
and button colours, where the app's journey styles are on. Vizzy only ever sets the
journey's DRAFT through the canvas endpoint: its emails change when an admin
publishes the journey. The journey is the one named, else the journey page in view
(`journeyId` in session state), else the launch in view's welcome journey
(`campaignId`).

Both tools write `state["journeyStyleEnabled"]` when the app says whether journey
styles are on (as get_lifecycle_context does), for the Lifecycle Ops instruction.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

READ_PATH = "/api/agent/journey-style"
CANVAS_PATH = "/api/agent/canvas"
_TIMEOUT_SECONDS = 30

# Says what Vizzy can do instead, so either agent that calls the tools offers it.
_OFF = (
    "Journey styles aren't switched on in this environment yet, so every journey wears the brand's "
    "Email style. I can suggest a change to that instead, for an admin to review in Brand › Email style."
)
# Only when this chat has no token or callback URL — never "switched on", since the
# feature may well be on.
_NO_LINK = "I can't reach the app from this chat yet — please send that again."

_ERRORS = {
    # The flag is off, or the app predates journey styles (no kind, no read route).
    "unavailable": _OFF,
    "unknown_kind": _OFF,
    "http_404": _OFF,
    "forbidden": (
        "Only an admin can set a journey's email style. An admin of this account can ask me, "
        "or change it in the journey's Settings."
    ),
    "unauthorized": "My session to the app expired — please send your message again.",
    "canvas_auth_unconfigured": "Journey styles from chat aren't set up in this environment yet.",
    "rate_limited": "I've set several journey styles just now. Please try again in a few minutes.",
    "invalid_input": "Some of the style wasn't valid",
    "invalid_style": "That style can't be saved",
    # The app may say why (a launch whose welcome emails haven't moved to the new engine).
    "journey_not_found": "I couldn't find that journey in this account, or it's archived.",
    "launch_not_found": "I couldn't find that launch in this account.",
    # EMAIL_HEADER_OPTIONS_ENABLED is off: only a real gradient or a forced text colour is refused.
    "header_options_unavailable": "Gradient headers and header text colour aren't switched on in this environment yet.",
    "network_error": "I couldn't reach the app just now. Please try again.",
}
# Whole on their own: the app's issue only says the same thing again.
_NO_DETAIL = {"header_options_unavailable"}
# The answers that mean journey styles are off here.
_OFF_CODES = {"unavailable", "unknown_kind", "http_404"}


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
    base = _ERRORS.get(code, "I couldn't do that with the journey's email style just now. Please try again.")
    detail = "" if code in _NO_DETAIL else "; ".join(str(i) for i in issues[:8])
    return {
        "status": "error",
        "code": code,
        "issues": issues[:20],
        # A whole sentence is followed by the app's; the others are finished by it.
        "message": (f"{base} {detail}" if base.endswith(".") else f"{base}: {detail}") if detail else base,
    }


def _remember(state: dict, result: dict) -> None:
    """Journey styles are on after a success and off after an "isn't switched on"; any other error says nothing."""
    if result.get("status") == "success":
        state["journeyStyleEnabled"] = True
    elif result.get("code") in _OFF_CODES:
        state["journeyStyleEnabled"] = False


def _id(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def journey_ref(state: "dict | None", journey_id: str = "", campaign_id: str = "") -> "dict | None":
    """Which journey: the one named (a journey's id, or a launch's for its welcome journey),
    else the journey page in view, else the launch in view. None when there's none. An empty
    id is none: the app's shared chat sends journeyId "" once it's off a journey page."""
    state = state or {}
    for key, value in (
        ("journeyId", journey_id),
        ("campaignId", campaign_id),
        ("journeyId", state.get("journeyId")),
        ("campaignId", state.get("campaignId")),
    ):
        if _id(value):
            return {key: _id(value)}
    return None


_NEEDS_JOURNEY = {
    "status": "needs_journey",
    "message": "Which journey do you mean? Ask me from the journey's page, or from the launch whose welcome emails it is.",
}


def build_set_payload(
    mode: str,
    ref: dict,
    header_color: str = "",
    button_color: str = "",
    header_gradient_color: str = "",
    solid_header: bool = False,
    header_text_color: str = "",
) -> dict:
    """The canvas request: the journey and only the fields the operator asked for, so the rest are kept."""
    payload: dict = {"kind": "journey_style", "action": "save_draft", **ref, "mode": (mode or "").strip().lower()}
    if (header_color or "").strip():
        payload["headerColor"] = header_color.strip()
    if (button_color or "").strip():
        payload["buttonColor"] = button_color.strip()
    # null makes the header solid again, so it wins over a colour 2.
    if solid_header:
        payload["headerGradientColor"] = None
    elif (header_gradient_color or "").strip():
        payload["headerGradientColor"] = header_gradient_color.strip()
    # "auto", "white" or "black"; the app checks it.
    if (header_text_color or "").strip():
        payload["headerText"] = header_text_color.strip().lower()
    return payload


def parse_set_response(status_code: int, body_text: str) -> dict:
    """Normalise the canvas endpoint's answer into a tool result (the card rides along)."""
    body = _json(body_text)
    if 200 <= status_code < 300 and body.get("ok"):
        return {
            "status": "success",
            "journeyId": body.get("id"),
            "url": body.get("url"),
            "warnings": body.get("warnings", []),
            "card": body.get("card"),
            "message": body.get("summary")
            or "Saved the journey's email style to its draft. Its emails change when the journey is published.",
        }
    return error_result(status_code, body)


def get_style(state: "dict | None", journey_id: str = "", campaign_id: str = "") -> dict:
    """Read the journey's draft and live style, and the brand's. Never raises."""
    ref = journey_ref(state, journey_id, campaign_id)
    if not ref:
        return dict(_NEEDS_JOURNEY)
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    status_code, body_text = _request("GET", base + READ_PATH + "?" + urllib.parse.urlencode(ref), token)
    body = _json(body_text)
    result = {"status": "success", **body} if 200 <= status_code < 300 else error_result(status_code, body)
    _remember(state, result)
    return result


def set_style(
    state: "dict | None",
    mode: str,
    header_color: str = "",
    button_color: str = "",
    header_gradient_color: str = "",
    solid_header: bool = False,
    header_text_color: str = "",
    journey_id: str = "",
    campaign_id: str = "",
) -> dict:
    """Save the journey's style to its DRAFT. Never raises."""
    ref = journey_ref(state, journey_id, campaign_id)
    if not ref:
        return dict(_NEEDS_JOURNEY)
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    payload = build_set_payload(
        mode,
        ref,
        header_color,
        button_color,
        header_gradient_color,
        solid_header,
        header_text_color,
    )
    status_code, body_text = _request("POST", base + CANVAS_PATH, token, payload)
    result = parse_set_response(status_code, body_text)
    _remember(state, result)
    return result
