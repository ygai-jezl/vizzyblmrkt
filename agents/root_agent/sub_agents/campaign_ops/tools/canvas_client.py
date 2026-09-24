"""Pure, ADK-free client logic for the build_email_journey tool.

Lives apart from build_journey.py (which imports ADK's ToolContext at runtime) so
the request/response/orchestration logic stays unit-testable without ADK
installed. The only side effect — the HTTP POST — is isolated in `_post_canvas`
so tests can monkeypatch it.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

CANVAS_PATH = "/api/agent/canvas"
_TIMEOUT_SECONDS = 60


def build_request_payload(campaign_id: str, brief: str, graph: dict) -> dict:
    """Shape the canvas-endpoint request body."""
    return {
        "kind": "journey",
        "campaignId": campaign_id,
        "brief": brief or "",
        "graph": graph or {"nodes": [], "edges": []},
        "action": "save_draft",
    }


def _error_message(body: dict) -> str:
    code = body.get("error")
    if code == "journey_active":
        return (
            "That launch already has an ACTIVE journey. Ask the operator to pause "
            "it first if they want it rebuilt."
        )
    if code == "campaign_not_found":
        return "I couldn't find that launch in this account."
    if code == "invalid_graph":
        issues = body.get("issues") or []
        detail = "; ".join(str(i) for i in issues[:5])
        return (
            f"The journey structure was invalid: {detail}"
            if detail
            else "The journey structure was invalid."
        )
    if code == "unknown_kind":
        return "That canvas type isn't available."
    if code == "canvas_auth_unconfigured":
        return "Journey authoring isn't enabled in this environment yet."
    return "I couldn't save the journey draft just now. Please try again."


def parse_canvas_response(status_code: int, body_text: str) -> dict:
    """Normalize the endpoint response into a tool-result dict."""
    try:
        body = json.loads(body_text) if body_text else {}
    except (json.JSONDecodeError, ValueError):
        body = {}
    if not isinstance(body, dict):
        body = {}

    if 200 <= status_code < 300 and body.get("ok"):
        return {
            "status": "success",
            "journeyId": body.get("journeyId"),
            "journeyStatus": body.get("status"),
            "warnings": body.get("warnings", []),
            "message": body.get("summary")
            or "Saved the journey as a draft. Review it on the Journey Canvas.",
            # The chat renders a card from these (an "Open canvas" link).
            "url": body.get("url"),
            "card": body.get("card"),
        }
    return {
        "status": "error",
        "code": body.get("error", f"http_{status_code}"),
        "message": _error_message(body),
    }


def _post_canvas(url: str, payload: dict, token: str) -> "tuple[int, str]":
    """POST to the canvas endpoint. Isolated so tests can monkeypatch it."""
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Canvas-Context": token,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_SECONDS) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", errors="replace")
    except urllib.error.URLError as exc:
        return 0, json.dumps({"error": "network_error", "detail": str(exc.reason)})


def author_journey_via_canvas(
    state: dict,
    campaign_id: str,
    brief: str,
    graph: dict,
) -> dict:
    """Read the capability token + active campaign from session state and POST the
    agent-assembled graph to the canvas endpoint. Returns a status dict to relay."""
    token = (state or {}).get("ctxToken")
    resolved_campaign = campaign_id or (state or {}).get("campaignId")

    if not token:
        return {
            "status": "unavailable",
            "message": "Journey authoring isn't available in this session yet.",
        }
    if not resolved_campaign:
        return {
            "status": "needs_campaign",
            "message": "Which launch should I build this journey for?",
        }

    base = os.environ.get("CANVAS_CALLBACK_URL", "").rstrip("/")
    if not base:
        return {
            "status": "unavailable",
            "message": "Journey authoring isn't configured (no callback URL).",
        }

    payload = build_request_payload(resolved_campaign, brief, graph)
    status_code, body_text = _post_canvas(base + CANVAS_PATH, payload, token)
    return parse_canvas_response(status_code, body_text)


# ---- Invite waves (nav v2 phase 4) -------------------------------------------------


def build_invite_wave_payload(
    campaign_id: str,
    brief: str,
    size: int = 0,
    expires_in_days: int = 0,
    wave_id: str = "",
) -> dict:
    """Shape the canvas request for an invite-wave draft. Zero / empty = let the server choose."""
    scope: dict = {"campaignId": campaign_id}
    if wave_id:
        scope["waveId"] = wave_id
    payload: dict = {
        "kind": "invite_wave",
        "action": "save_draft",
        "scope": scope,
        "brief": brief or "",
    }
    if size and size > 0:
        payload["size"] = int(min(size, 1000))
    if expires_in_days and expires_in_days > 0:
        payload["expiresInDays"] = int(min(max(expires_in_days, 7), 90))
    return payload


def _invite_error_message(body: dict) -> str:
    code = body.get("error")
    issues = body.get("issues") or []
    if code == "invites_locked":
        reason = str(issues[0]) if issues else "the launch isn't ready for invites yet"
        return f"I can't draft an invite for this launch yet: {reason}"
    if code == "unavailable":
        return "Waitlist invites aren't switched on in this environment yet."
    if code == "campaign_not_found":
        return "I couldn't find that launch in this account."
    if code == "wave_not_found":
        return "I couldn't find that invite draft — it may have been sent or deleted."
    if code == "rate_limited":
        return "I've drafted several invites just now. Please try again in a few minutes."
    if code == "canvas_auth_unconfigured":
        return "Drafting from chat isn't enabled in this environment yet."
    return "I couldn't save the invite draft just now. Please try again."


def parse_invite_wave_response(status_code: int, body_text: str) -> dict:
    """Normalize the canvas response for an invite-wave draft."""
    try:
        body = json.loads(body_text) if body_text else {}
    except (json.JSONDecodeError, ValueError):
        body = {}
    if not isinstance(body, dict):
        body = {}
    if 200 <= status_code < 300 and body.get("ok"):
        return {
            "status": "success",
            "waveId": body.get("id"),
            "message": body.get("summary")
            or "Saved the invite as a draft. Nothing is sent until the operator presses Send invites.",
            "url": body.get("url"),
            "card": body.get("card"),
        }
    return {
        "status": "error",
        "code": body.get("error", f"http_{status_code}"),
        "message": _invite_error_message(body),
    }


def draft_invite_wave_via_canvas(
    state: dict,
    campaign_id: str,
    brief: str,
    size: int = 0,
    expires_in_days: int = 0,
    wave_id: str = "",
) -> dict:
    """Save an invite of a launch's waitlist into the product as a DRAFT wave."""
    token = (state or {}).get("ctxToken")
    resolved_campaign = campaign_id or (state or {}).get("campaignId")
    if not token:
        return {"status": "unavailable", "message": "Drafting invites isn't available in this session yet."}
    if not resolved_campaign:
        return {"status": "needs_campaign", "message": "Which launch's waitlist should I invite?"}
    base = os.environ.get("CANVAS_CALLBACK_URL", "").rstrip("/")
    if not base:
        return {"status": "unavailable", "message": "Drafting invites isn't configured (no callback URL)."}
    payload = build_invite_wave_payload(resolved_campaign, brief, size, expires_in_days, wave_id)
    status_code, body_text = _post_canvas(base + CANVAS_PATH, payload, token)
    return parse_invite_wave_response(status_code, body_text)

