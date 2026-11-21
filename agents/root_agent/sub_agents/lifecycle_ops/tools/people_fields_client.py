"""Pure, ADK-free client logic for Lifecycle Ops' people fields tools.

Lives apart from lifecycle_tools.py (which imports ADK's ToolContext at runtime) so
the request and response logic stays unit-testable without ADK. The only side
effect, the HTTP call, is isolated in `_request` so tests can monkeypatch it.

Every call carries the signed capability token (`ctxToken` in session state) as
`X-Canvas-Context`; the app takes the brand from that token, never from here. The
app only ever sends the field types Vizzy may read (select, multi select, status,
checkbox, number, currency and date, and text fields the brand lets it read, scrubbed
and cut to 500 characters), and never a name or an address.
Suggestions are saved for someone on the team to confirm: nothing changes until
then. `personFieldsEnabled` is written on every answer that shows whether the
switch is on, so the instruction builder's fields rule comes and goes with it.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

FIELDS_PATH = "/api/agent/audience/fields"
PEOPLE_PATH = "/api/agent/audience/people/"
CANVAS_PATH = "/api/agent/canvas"
_TIMEOUT_SECONDS = 30

_ERRORS = {
    "unavailable": "Reading people's fields isn't switched on in this environment.",
    "canvas_auth_unconfigured": "Reading fields from chat isn't enabled in this environment yet.",
    "unauthorized": "My session to the app expired. Please send your message again.",
    "rate_limited": "I've read a lot of fields in the last hour. Please try again a bit later.",
    "person_not_found": "I couldn't find that person in this account. Their fields are on a person's page in your list of people.",
    "forbidden": "Only an admin on the team can ask me to suggest changes to someone's fields.",
    "unknown_field": "One of those fields isn't on the list any more. Let me read the fields again.",
    "archived_field": "That field was archived, so I can't suggest a value for it.",
    "field_not_allowed": "I can only suggest select, multi select, status, checkbox, number, currency and date fields, and text fields the brand lets me read.",
    "invalid_value": "One of the values doesn't fit its field. Use the option ids and value shapes the fields read gives; text is at most 500 characters, with no [name], [email] or [id] in it, and a text value marked cut can only be cleared with null.",
    "no_change": "Their fields already hold those values, so there's nothing to suggest.",
    "already_decided": "Someone on the team already decided that exact suggestion, so I won't raise it again.",
    "too_many_fields": "That's too many fields for one suggestion. Suggest up to 20 at once.",
    "too_large": "That suggestion is too big to save. Suggest fewer fields, or shorter text, at once.",
    "invalid_input": "The suggestion was missing something",
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
    if not token:
        return {"status": "unavailable", "message": "Reading people's fields isn't available in this session yet."}
    base = os.environ.get("CANVAS_CALLBACK_URL", "").rstrip("/")
    if not base:
        return {"status": "unavailable", "message": "Reading people's fields isn't configured (no callback URL)."}
    return base, token


def _error(state: "dict | None", status_code: int, body: dict) -> dict:
    code = body.get("error") or f"http_{status_code}"
    if code == "unavailable" and state is not None:
        state["personFieldsEnabled"] = False
    message = _ERRORS.get(code, "I couldn't do that just now. Please try again.")
    issues = body.get("issues") or []
    if code == "invalid_input" and issues:
        message = f"{message}: " + "; ".join(str(i) for i in issues[:4])
    return {"status": "error", "code": code, "message": message}


def _person(state: "dict | None", person_id: str) -> "str | None":
    """The person asked for, else the one in view."""
    resolved = (person_id or "").strip() or (state or {}).get("personId")
    return str(resolved) if resolved else None


_NEEDS_PERSON = {
    "status": "needs_person",
    "message": "Open the person's page from your list of people and ask me there. I can only look at the person in view.",
}


def list_fields(state: "dict | None") -> dict:
    """The brand's People fields Vizzy may read and suggest, with their options, and no values."""
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    status_code, body_text = _request("GET", base + FIELDS_PATH, token)
    body = _json(body_text)
    if 200 <= status_code < 300:
        if state is not None:
            state["personFieldsEnabled"] = True
        return {"status": "success", "fields": body.get("fields") or [], "note": body.get("note")}
    return _error(state, status_code, body)


def read_person(state: "dict | None", person_id: str) -> dict:
    """One person's values of those fields, and which already have a suggestion waiting."""
    resolved = _person(state, person_id)
    if not resolved:
        return dict(_NEEDS_PERSON)
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    url = base + PEOPLE_PATH + urllib.parse.quote(resolved, safe="") + "/fields"
    status_code, body_text = _request("GET", url, token)
    body = _json(body_text)
    if 200 <= status_code < 300:
        if state is not None:
            state["personFieldsEnabled"] = True
        return {"status": "success", "fields": body.get("fields") or [], "waiting": body.get("waiting") or [], "note": body.get("note")}
    return _error(state, status_code, body)


def build_propose_payload(person_id: str, changes: "dict | None", why: str) -> dict:
    return {
        "kind": "person_fields",
        "action": "save_draft",
        "scope": {"personId": person_id},
        "changes": dict(changes or {}),
        "why": (why or "").strip()[:1000],
    }


def propose(state: "dict | None", changes: "dict | None", why: str, person_id: str = "") -> dict:
    """Save a suggestion for the person asked for, else the one in view. Someone on the team confirms it."""
    resolved = _person(state, person_id)
    if not resolved:
        return dict(_NEEDS_PERSON)
    if not isinstance(changes, dict) or not changes:
        return {"status": "needs_changes", "message": "Say which fields to change and to what: read their fields first for the ids."}
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    status_code, body_text = _request("POST", base + CANVAS_PATH, token, build_propose_payload(resolved, changes, why))
    body = _json(body_text)
    if 200 <= status_code < 300 and body.get("ok"):
        if state is not None:
            state["personFieldsEnabled"] = True
        return {
            "status": "success",
            "suggestionId": body.get("id"),
            "url": body.get("url"),
            "card": body.get("card"),
            "message": body.get("summary") or "Saved as a suggestion. Nothing changes until someone on the team confirms it.",
        }
    return _error(state, status_code, body)
