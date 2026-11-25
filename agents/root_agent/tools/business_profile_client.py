"""Pure, ADK-free client logic for the business profile: the before-model callback's short read,
and the get_business_profile, read_onboarding_conversation and suggest_business_fact tools.

Mirrors brand_notes_client.py: the request/response logic lives here (no ADK import) so it stays
unit-testable without ADK; the only side effect, the HTTP call, is isolated in `_request` so tests
can monkeypatch it. Auth reuses the signed canvas capability token (`ctxToken` in session state);
the app takes the brand and the person's role from that token, never from here.

The profile is what the brand told Vizzy (ONBOARDING_ENABLED): the four answers, and the facts an
admin kept, each with the founder's own words. Members read the answers only; facts, quotes and
conversations are for admins. Vizzy only SUGGESTS a new fact: it waits until an admin keeps it in
Settings, About your business. Nothing here logs what anyone said.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

PATH = "/api/agent/business-profile"
_TIMEOUT_SECONDS = 30
#: The callback's read must never hold up a chat for long.
CHAT_READ_TIMEOUT_SECONDS = 5

KINDS = ("timeline", "channel", "start", "constraint", "goal")
_KIND_ALIASES = {"starting point": "start", "deadline": "timeline", "date": "timeline"}
_CONVERSATION_ID = re.compile(r"^oc_[a-f0-9]{32}$")

_OFF = "Getting to know the business isn't switched on in this environment yet."
_NO_LINK = "I can't reach the app from this chat yet. Please send that again."

_ERRORS = {
    "unavailable": _OFF,
    "http_404": _OFF,
    "not_found": "There's no such conversation kept for this brand.",
    "unauthorized": "My session to the app expired. Please send your message again.",
    "canvas_auth_unconfigured": "Reading the business profile isn't set up in this environment yet.",
    "admins_only": "Only an admin can add to About your business, or read the conversations and the founder's words.",
    "call_words_off": "This copy of YouGrow keeps the words from calls with Vizzy out of chats. Answer from the facts in About your business.",
    "too_many_waiting": "Ten things already wait for an admin in About your business. They need to keep or remove some first.",
    "too_many_facts": "About your business holds as many facts as it can. An admin needs to remove some first.",
    "already_known": "About your business already has that.",
    "already_decided": "An admin already kept or removed that one, so I won't suggest it again.",
    "rate_limited": "I've suggested several things just now. Please try again in a few minutes.",
    "invalid_input": "That wasn't a fact I can suggest",
    "network_error": "I couldn't reach the app just now. Please try again.",
}


def _request(method: str, url: str, token: str, payload: "dict | None" = None, timeout: float = _TIMEOUT_SECONDS) -> "tuple[int, str]":
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
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return 0, json.dumps({"error": "network_error", "detail": type(exc).__name__})


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
    base = _ERRORS.get(code, "I couldn't do that with About your business just now. Please try again.")
    detail = "; ".join(str(i) for i in issues[:5])
    return {"status": "error", "code": code, "issues": issues[:10], "message": f"{base}: {detail}" if detail else base}


def fetch_chat_profile(state: "dict | None", timeout: float = CHAT_READ_TIMEOUT_SECONDS) -> "dict | None":
    """The short view the callback reads before a chat, or None when it can't be had. Never raises."""
    got = _base_and_token(state)
    if isinstance(got, dict):
        return None
    base, token = got
    try:
        status_code, body_text = _request("GET", base + PATH + "?view=chat", token, timeout=timeout)
    except Exception:  # noqa: BLE001 - the callback fails soft whatever happens
        return None
    if not 200 <= status_code < 300:
        return None
    body = _json(body_text)
    return body or None


def get_profile(state: "dict | None") -> dict:
    """The whole profile, as the person's role allows. Never raises."""
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    status_code, body_text = _request("GET", base + PATH, token)
    body = _json(body_text)
    if 200 <= status_code < 300:
        return {"status": "success", **body}
    return error_result(status_code, body)


def read_conversation(state: "dict | None", conversation_id: str) -> dict:
    """One kept conversation, whole (admins). Never raises."""
    cid = (conversation_id or "").strip()
    if not _CONVERSATION_ID.match(cid):
        return {"status": "error", "code": "bad_id", "message": "Use a conversation id from get_business_profile's `conversations` (it starts with oc_)."}
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    status_code, body_text = _request("GET", f"{base}{PATH}/conversations/{urllib.parse.quote(cid)}", token)
    body = _json(body_text)
    if 200 <= status_code < 300:
        return {"status": "success", **body}
    return error_result(status_code, body)


def kind_of(kind: str) -> "str | None":
    """A fact's kind as the app takes it, or None."""
    k = " ".join((kind or "").lower().replace("-", " ").replace("_", " ").split())
    k = _KIND_ALIASES.get(k, k)
    return k if k in KINDS else None


def suggest(state: "dict | None", kind: str, text: str, quote: str, asked: str = "") -> dict:
    """Suggest one fact for an admin to keep. The quote is sent exactly as given. Never raises."""
    k = kind_of(kind)
    if not k:
        return {"status": "error", "code": "bad_kind", "message": f"The kind is one of {', '.join(KINDS)}."}
    if not (text or "").strip() or not (quote or "").strip():
        return {"status": "error", "code": "nothing_to_suggest", "message": "I need a few plain words for the fact and the person's own words for it."}
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    payload = {"kind": k, "text": text.strip(), "quote": quote}
    if (asked or "").strip():
        payload["asked"] = asked.strip()
    status_code, body_text = _request("POST", base + PATH, token, payload)
    body = _json(body_text)
    if 200 <= status_code < 300:
        return {
            "status": "success",
            "outcome": body.get("outcome"),
            "message": body.get("message") or "Saved for an admin to keep in Settings, About your business.",
            "card": body.get("card"),
        }
    return error_result(status_code, body)
