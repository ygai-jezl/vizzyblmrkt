"""Pure, ADK-free client logic for the get_brand_notes and suggest_brand_notes tools.

Mirrors brand_map_client.py: the request/response logic lives here (no ADK import) so it
stays unit-testable without ADK; the only side effect, the HTTP call, is isolated in
`_request` so tests can monkeypatch it. Auth reuses the signed canvas capability token
(`ctxToken` in session state); the app takes the tenant from that token, never from here.

What we've seen is the brand's own first-hand experience, written by its team: customer
stories, things it tested, mistakes it sees, objections it hears, its own numbers, before
and after, where it disagrees. Blog articles draw on the notes an admin has kept. Vizzy
only files SUGGESTED notes, in the person's own words; it never invents experience.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

PATH = "/api/agent/brand-notes"
_TIMEOUT_SECONDS = 30
_MAX_PER_CALL = 5  # what the app takes in one call
_KINDS = {"customer_story", "tested", "mistake", "objection", "numbers", "before_after", "disagree"}

_OFF = "What we've seen isn't switched on in this environment yet."
_NO_LINK = "I can't reach the app from this chat yet. Please send that again."

_ERRORS = {
    "unavailable": _OFF,
    "http_404": _OFF,
    "unauthorized": "My session to the app expired. Please send your message again.",
    "canvas_auth_unconfigured": "Notes from chat aren't set up in this environment yet.",
    "rate_limited": "I've filed several notes just now. Please try again in a few minutes.",
    "invalid_input": "Some of the notes weren't valid",
    "too_many_notes": "The brand holds as many notes as it can. An admin needs to remove some on Brand › What we've seen first.",
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


def _base_and_token(state: "dict | None") -> "tuple[str, str] | dict":
    token = (state or {}).get("ctxToken")
    base = os.environ.get("CANVAS_CALLBACK_URL", "").rstrip("/")
    if not token or not base:
        return {"status": "error", "code": "not_connected", "message": _NO_LINK}
    return base, token


def error_result(status_code: int, body: dict) -> dict:
    code = body.get("error") or f"http_{status_code}"
    issues = body.get("issues") or []
    base = _ERRORS.get(code, "I couldn't do that with What we've seen just now. Please try again.")
    detail = "; ".join(str(i) for i in issues[:5])
    return {"status": "error", "code": code, "issues": issues[:10], "message": f"{base}: {detail}" if detail else base}


def get_notes(state: "dict | None", find: str = "") -> dict:
    """Read the brand's notes: how many of each kind, the kinds it has fewest of, and the newest
    (or those nearest `find`). Never raises."""
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    query = f"?find={urllib.parse.quote(find.strip()[:300])}" if (find or "").strip() else ""
    status_code, body_text = _request("GET", base + PATH + query, token)
    body = _json(body_text)
    if 200 <= status_code < 300:
        return {"status": "success", **body}
    return error_result(status_code, body)


def build_notes(lines: "list | None") -> "tuple[list, list]":
    """Notes to file, from "note" or "kind | note" lines, and the lines that couldn't be read."""
    notes: list = []
    unread: list = []
    for line in lines or []:
        text = str(line).strip()
        if not text:
            continue
        head, sep, rest = text.partition("|")
        kind = head.strip().lower().replace(" ", "_")
        if sep and kind in _KINDS and rest.strip():
            notes.append({"kind": kind, "text": rest.strip()})
        elif len(text) >= 12:
            notes.append({"text": text})
        else:
            unread.append(f'"{text}" is too short to be a note')
    return notes, unread


def suggest(state: "dict | None", notes: "list | None") -> dict:
    """File notes as suggestions an admin keeps. Never raises."""
    built, unread = build_notes(notes)
    if not built:
        return {
            "status": "error",
            "code": "nothing_to_file",
            "message": "There was no note to file. Use the person's own words, a sentence or more each.",
            "unread": unread,
        }
    if len(built) > _MAX_PER_CALL:
        return {"status": "error", "code": "too_many", "message": f"I can file at most {_MAX_PER_CALL} notes at a time."}
    got = _base_and_token(state)
    if isinstance(got, dict):
        return got
    base, token = got
    status_code, body_text = _request("POST", base + PATH, token, {"notes": built})
    body = _json(body_text)
    if 200 <= status_code < 300:
        return {"status": "success", **body, **({"unread": unread} if unread else {})}
    return error_result(status_code, body)
