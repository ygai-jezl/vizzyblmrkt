"""Pure, ADK-free client logic for the new_person_propose tool.

Mirrors audience_client.py: the request and response logic lives here (no ADK import)
so it stays unit-testable without ADK; the only side effect, the HTTP POST, is
isolated in `_post` so tests can monkeypatch it. Auth reuses the signed canvas token
(`ctxToken` in session state); the app takes the brand from that token, never from
here.

It fills in the New person form for an admin to open, check and confirm. It never
sends consent: the admin records how someone agreed. What was typed is kept by the
app until the form is confirmed or dismissed, or for at most 7 days.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

CANVAS_PATH = "/api/agent/canvas"
_TIMEOUT_SECONDS = 30

_ERRORS = {
    "unavailable": "Adding people from chat isn't switched on in this environment.",
    "canvas_auth_unconfigured": "Adding people from chat isn't enabled in this environment yet.",
    "unauthorized": "My session to the app expired. Please send your message again.",
    "forbidden": "Only an admin on the team can add people, so I can't fill in the form for you.",
    "email_or_phone": "I need an email address or a phone number to fill in the form.",
    "invalid_email": "That email address doesn't look right. Check it and tell me again.",
    "invalid_phone": "That phone number doesn't look right. Use digits, with + and spaces if you like.",
    "consent_not_allowed": "I can't record that someone agreed to emails: the admin says how they agreed in the form.",
    "rate_limited": "I've filled in a lot of forms in the last hour. Please try again a bit later.",
    "too_large": "That form is too big to save. Fill in fewer fields, or shorter text.",
    "invalid_input": "The form was missing something",
}


def _post(url: str, token: str, payload: dict) -> "tuple[int, str]":
    """POST to the canvas endpoint. Isolated so tests can monkeypatch it."""
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST", headers={"X-Canvas-Context": token, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_SECONDS) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", errors="replace")
    except urllib.error.URLError as exc:
        return 0, json.dumps({"error": "network_error", "detail": str(exc.reason)})


def build_payload(email: str, phone: str, first_name: str, last_name: str, fields: "dict | None") -> dict:
    """Only what was given; never consent."""
    payload: dict = {"kind": "new_person", "action": "save_draft"}
    for key, value in (("email", email), ("phone", phone), ("firstName", first_name), ("lastName", last_name)):
        text = (value or "").strip()
        if text:
            payload[key] = text
    if isinstance(fields, dict) and fields:
        payload["fields"] = dict(fields)
    return payload


def propose(state: "dict | None", email: str, phone: str, first_name: str, last_name: str, fields: "dict | None") -> dict:
    """Fill in the New person form for an admin to confirm. Never raises."""
    if not (email or "").strip() and not (phone or "").strip():
        return {"status": "needs_contact", "message": "I need their email address or phone number to fill in the form. Ask the operator for it."}
    token = (state or {}).get("ctxToken")
    if not token:
        return {"status": "unavailable", "message": "Adding people isn't available in this session yet."}
    base = os.environ.get("CANVAS_CALLBACK_URL", "").rstrip("/")
    if not base:
        return {"status": "unavailable", "message": "Adding people isn't configured (no callback URL)."}
    status_code, body_text = _post(base + CANVAS_PATH, token, build_payload(email, phone, first_name, last_name, fields))
    try:
        body = json.loads(body_text) if body_text else {}
    except (json.JSONDecodeError, ValueError):
        body = {}
    if not isinstance(body, dict):
        body = {}
    if 200 <= status_code < 300 and body.get("ok"):
        existing = body.get("status") == "existing"
        return {
            "status": "existing" if existing else "success",
            **({} if existing else {"draftId": body.get("id")}),
            "url": body.get("url"),
            "card": body.get("card"),
            "warnings": body.get("warnings") or [],
            "message": body.get("summary") or ("They're already in People." if existing else "Filled in the New person form for an admin to confirm."),
        }
    code = body.get("error") or f"http_{status_code}"
    message = _ERRORS.get(code, "I couldn't fill in the form just now. Please try again.")
    issues = body.get("issues") or []
    if code == "invalid_input" and issues:
        message = f"{message}: " + "; ".join(str(i) for i in issues[:4])
    return {"status": "error", "code": code, "message": message}
