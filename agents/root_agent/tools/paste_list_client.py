"""Pure, ADK-free client logic for the paste_list_propose tool.

Mirrors new_person_client.py: the request and response logic lives here (no ADK import) so it
stays unit-testable without ADK; the only side effect, the HTTP POST, is isolated in `_post` so
tests can monkeypatch it. Auth reuses the signed canvas token (`ctxToken` in session state); the
app takes the brand from that token, never from here.

It sends the rows the operator pasted, exactly as pasted, and where the list is from. The app's
own code reads them into one card in Review for an admin to add: Vizzy never reads, completes or
invents rows, and never sends consent. Its answer names left out rows by number only, never a cell.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

PASTE_PATH = "/api/agent/audience/paste"
_TIMEOUT_SECONDS = 30
# The app reads at most this many characters of pasted text (src/lib/crm/paste/parse.ts).
MAX_TEXT_CHARS = 200_000

_TOO_LONG = "That's too much text to read at once. Paste fewer rows or columns."

# The client's own words for the gate's answers; for a paste code the route's own `message` is relayed.
_ERRORS = {
    "unavailable": "Pasting a list into chat isn't switched on here. Use Paste a list on People instead.",
    "canvas_auth_unconfigured": "Pasting a list into chat isn't enabled in this environment yet. Use Paste a list on People instead.",
    "unauthorized": "My session to the app expired. Please send your message again.",
    "forbidden": "Only an admin on the team can add a list, so I can't read it into a card for you.",
    "rate_limited": "I've read a lot of lists in the last hour. Please try again a bit later.",
    "consent_not_allowed": "I can't record that anyone agreed to emails: everyone on a pasted list starts at Not yet, and an admin records an agreement on their page.",
}


def encode_payload(payload: dict) -> bytes:
    """The body as UTF-8 JSON, with accents and other scripts kept as they are, not as 6 byte escapes."""
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def _post(url: str, token: str, payload: dict) -> "tuple[int, str]":
    """POST to the paste endpoint. Isolated so tests can monkeypatch it."""
    data = encode_payload(payload)
    req = urllib.request.Request(url, data=data, method="POST", headers={"X-Canvas-Context": token, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_SECONDS) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", errors="replace")
    except urllib.error.URLError as exc:
        return 0, json.dumps({"error": "network_error", "detail": str(exc.reason)})


def build_payload(text: str, source: str) -> dict:
    """The rows as pasted and where they are from: never consent, never a brand."""
    return {"text": text, "source": (source or "").strip()}


def propose(state: "dict | None", text: str, source: str) -> dict:
    """Read a pasted list into one Review card for an admin to add. Never raises."""
    if not (text or "").strip():
        return {"status": "needs_rows", "message": "Paste the rows, header row first, and I'll read them."}
    if not (source or "").strip():
        return {"status": "needs_source", "message": "Ask the operator where this list is from, then call again."}
    if len(text) > MAX_TEXT_CHARS:
        return {"status": "error", "code": "too_long", "message": _TOO_LONG}
    token = (state or {}).get("ctxToken")
    if not token:
        return {"status": "unavailable", "message": "Pasting a list isn't available in this session yet."}
    base = os.environ.get("CANVAS_CALLBACK_URL", "").rstrip("/")
    if not base:
        return {"status": "unavailable", "message": "Pasting a list isn't configured (no callback URL)."}
    status_code, body_text = _post(base + PASTE_PATH, token, build_payload(text, source))
    try:
        body = json.loads(body_text) if body_text else {}
    except (json.JSONDecodeError, ValueError):
        body = {}
    if not isinstance(body, dict):
        body = {}
    left_out = body.get("leftOut") if isinstance(body.get("leftOut"), list) else []
    if 200 <= status_code < 300 and body.get("ok"):
        if body.get("status") == "nothing_to_add":
            return {"status": "nothing_to_add", "leftOut": left_out, "message": body.get("summary") or "Nothing to add: every row is already here or was left out."}
        return {
            "status": "ready",
            "batchId": body.get("id"),
            "url": body.get("url"),
            "card": body.get("card"),
            "counts": body.get("counts") or {},
            "leftOut": left_out,
            "message": body.get("summary") or "Read the list into one card in Review for an admin to add.",
        }
    code = body.get("error") or f"http_{status_code}"
    if code in _ERRORS:
        message = _ERRORS[code]
    elif isinstance(body.get("message"), str) and body["message"].strip():
        # A paste code (source_needed, no_header, too_many_rows and the rest): the app's own words.
        message = body["message"]
    else:
        message = "I couldn't read the list just now. Please try again, or use Paste a list on People."
    return {"status": "error", "code": code, "message": message}
