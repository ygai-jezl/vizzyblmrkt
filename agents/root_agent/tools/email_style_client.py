"""Pure, ADK-free client logic for the get_email_style and suggest_email_style tools.

Mirrors insights_client.py: the request/response logic lives here (no ADK import)
so it stays unit-testable without ADK; the only side effect — the HTTP call — is
isolated in `_request` so tests can monkeypatch it. Auth reuses the signed canvas
capability token (`ctxToken` in session state); the app takes the tenant and the
role from that token, never from here.

The Email style is brand-wide (logo, company name, header and button colours on
every branded email, plus a gradient header, the header text colour and a header
image an admin uploaded where the app's header options are on, and a theme, a look
with a heading and a body font, where its themes are on). Vizzy only ever saves
a SUGGESTION through the canvas endpoint: nothing changes until an admin saves it on
Brand › Email style. Vizzy never uploads a header image; only the page can.
"""

from __future__ import annotations

import json
import os
import re
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
    "invalid_header_image": "That header image can't be used",
    "header_images_unavailable": "I couldn't read your header images just now. Please try again.",
    # EMAIL_HEADER_OPTIONS_ENABLED is off: only a real gradient, forced text colour or header
    # image id is refused.
    "header_options_unavailable": (
        "Gradient headers, header text colour and header images aren't switched on in this "
        "environment yet."
    ),
    # EMAIL_THEMES_ENABLED is off: only a look other than Classic, a font other than the
    # system font, or "use brand fonts" is refused.
    "themes_unavailable": "Email themes and fonts aren't switched on in this environment yet.",
    "network_error": "I couldn't reach the app just now. Please try again.",
}
# Whole on their own: the app's issue only says the same thing again.
_NO_DETAIL = {"header_options_unavailable", "themes_unavailable"}


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
    detail = "" if code in _NO_DETAIL else "; ".join(str(i) for i in issues[:8])
    return {
        "status": "error",
        "code": code,
        "issues": issues[:20],
        "message": f"{base}: {detail}" if detail else base,
    }


# A font's label where it isn't its id with dashes for spaces ("Trebuchet MS" is "trebuchet").
_FONT_LABEL_IDS = {"trebuchet-ms": "trebuchet"}


def _font_id(value: str) -> str:
    """A font id from the read's `fonts`, or its label ("Playfair Display" → "playfair-display")."""
    font = re.sub(r"[\s_]+", "-", value.strip().lower())
    return _FONT_LABEL_IDS.get(font, font)


def build_suggest_payload(
    mode: str,
    brief: str,
    header_color: str = "",
    button_color: str = "",
    logo: str = "",
    company_name: str = "",
    hide_company_name: bool = False,
    header_gradient_color: str = "",
    solid_header: bool = False,
    header_text_color: str = "",
    header_image: str = "",
    theme: str = "",
    heading_font: str = "",
    body_font: str = "",
    use_brand_fonts: bool = False,
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
    # null makes the header solid again, so it wins over a colour 2.
    if solid_header:
        payload["headerGradientColor"] = None
    elif (header_gradient_color or "").strip():
        payload["headerGradientColor"] = header_gradient_color.strip()
    # "auto", "white" or "black"; the app checks it.
    if (header_text_color or "").strip():
        payload["headerText"] = header_text_color.strip().lower()
    # A banner's id from the read's headerImages (ids are case-sensitive), or "none" for
    # the colour header; the app checks it.
    image = (header_image or "").strip()
    if image:
        payload["headerImage"] = "none" if image.lower() == "none" else image
    if (button_color or "").strip():
        payload["buttonColor"] = button_color.strip()
    if (logo or "").strip():
        payload["logo"] = logo.strip()
    # null hides the name, so the logo shows alone.
    if hide_company_name:
        payload["companyName"] = None
    elif (company_name or "").strip():
        payload["companyName"] = company_name.strip()
    # A look ("classic", "modern", "editorial" or "friendly") and font ids from the read's
    # `fonts` (a label is sent as its id), all lowercase; the app checks them.
    if (theme or "").strip():
        payload["theme"] = theme.strip().lower()
    if (heading_font or "").strip():
        payload["headingFont"] = _font_id(heading_font)
    if (body_font or "").strip():
        payload["bodyFont"] = _font_id(body_font)
    # The fonts from Brand › Fonts where email has them; a font given as well wins.
    if use_brand_fonts:
        payload["useBrandFonts"] = True
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
    header_gradient_color: str = "",
    solid_header: bool = False,
    header_text_color: str = "",
    header_image: str = "",
    theme: str = "",
    heading_font: str = "",
    body_font: str = "",
    use_brand_fonts: bool = False,
) -> dict:
    """Save an Email style SUGGESTION for an admin to review. Never raises."""
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    payload = build_suggest_payload(
        mode,
        brief,
        header_color,
        button_color,
        logo,
        company_name,
        hide_company_name,
        header_gradient_color,
        solid_header,
        header_text_color,
        header_image,
        theme,
        heading_font,
        body_font,
        use_brand_fonts,
    )
    status_code, body_text = _request("POST", base + CANVAS_PATH, token, payload)
    return parse_suggest_response(status_code, body_text)
